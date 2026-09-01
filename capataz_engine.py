"""
Capataz — responde WhatsApp vía Ollama.

Entrada de mensajes (2 fuentes):
  1. Bridge msg  GET /api/hermes/inbox  (webhooks OpenWA → msg :3445)
  2. OpenWA directo  GET /sessions/.../chats + history  (fallback local :2785)

Salida: POST OpenWA send-text + typing en OPENWA_BASE_URL
"""

import os
import json
import time
import sqlite3
import random
import requests
from datetime import datetime, timezone
from urllib.parse import quote
from dotenv import load_dotenv

load_dotenv()


def normalize_host_url(url: str) -> str:
    """Evita localhost → ::1 (IPv6) en WSL/Windows; OpenWA suele escuchar solo IPv4."""
    return (url or "").replace("://localhost", "://127.0.0.1").strip()


def normalize_openwa_base(url: str) -> str:
    """Asegura http://127.0.0.1:2785/api (con /api)."""
    base = normalize_host_url(url).rstrip("/")
    if not base:
        return ""
    if not base.endswith("/api"):
        base = f"{base}/api"
    return base


BRIDGE_URL = normalize_host_url(os.getenv("HERMES_BRIDGE_URL", "http://127.0.0.1:3445")).rstrip("/")
BRIDGE_TOKEN = os.getenv("HERMES_BRIDGE_TOKEN", "").strip()
OPENWA_BASE_URL = normalize_openwa_base(os.getenv("OPENWA_BASE_URL", "http://127.0.0.1:2785/api"))
OPENWA_API_KEY = os.getenv("OPENWA_API_KEY", "").strip()
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434/api/chat")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma4:12b")
OLLAMA_THINK = os.getenv("OLLAMA_THINK", "").strip().lower() in ("1", "true", "yes")

POLLING_INTERVAL = int(os.getenv("POLLING_INTERVAL_SEC", 3))
TYPING_MIN = int(os.getenv("TYPING_MIN_SEC", 2))
TYPING_MAX = int(os.getenv("TYPING_MAX_SEC", 5))

OPENWA_POLL_ENABLED = os.getenv("CAPATAZ_OPENWA_POLL", "true").strip().lower() not in (
    "false",
    "0",
    "no",
)
OPENWA_SESSION_IDS = [
    s.strip()
    for s in os.getenv("OPENWA_SESSION_IDS", "").split(",")
    if s.strip()
]

BRIDGE_HEADERS = {
    "X-Hermes-Token": BRIDGE_TOKEN,
    "Content-Type": "application/json",
}
OPENWA_HEADERS = {
    "X-API-Key": OPENWA_API_KEY,
    "Content-Type": "application/json",
}

SYSTEM_PROMPT = (
    "Eres Mónica, asistente de reclutamiento de Pro Talent. Tu objetivo es agendar reuniones de forma amable y efectiva. "
    "Tono: Profesional, cálido, breve (estilo WhatsApp). No uses párrafos largos.\n"
    "REGLA DE ORO: NUNCA preguntes '¿cuándo puedes?'. SIEMPRE propón dos opciones concretas (ej: '¿Te queda mejor mañana a las 10:00 o el jueves a las 15:00?').\n"
    "OBJECIONES: Si dicen que no les interesa o están ocupados, ofrece un beneficio breve y retírate si no hay interés.\n"
    "CIERRE: Si aceptan o piden el link, el objetivo se cumple.\n"
    "Responde siempre en ESPAÑOL."
)


def require_env(name, value):
    if not value:
        raise RuntimeError(f"Falta {name} en .env")


def phone_from_chat_id(chat_id: str) -> str:
    return "".join(c for c in str(chat_id or "") if c.isdigit())


def safe_int(val, default=0):
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return default


def wa_ts_to_iso(ts) -> str:
    """Convierte timestamp WA a ISO; evita OSError 22 en Windows/WSL con fechas inválidas."""
    try:
        if ts is None or ts == "":
            return datetime.now(timezone.utc).isoformat()
        n = float(ts)
        if n != n or n <= 0:  # NaN o negativo
            return datetime.now(timezone.utc).isoformat()
        if n > 1e12:
            n = n / 1000.0
        if n > 4102444800:  # > año 2100 en segundos
            return datetime.now(timezone.utc).isoformat()
        return datetime.fromtimestamp(n, tz=timezone.utc).isoformat()
    except (OSError, ValueError, OverflowError):
        return datetime.now(timezone.utc).isoformat()


class CapatazEngine:
    def __init__(self, db_path="capataz_memory.db"):
        require_env("HERMES_BRIDGE_TOKEN", BRIDGE_TOKEN)
        require_env("OPENWA_BASE_URL", OPENWA_BASE_URL)
        require_env("OPENWA_API_KEY", OPENWA_API_KEY)

        self.db_path = db_path
        self.last_poll_ts = None
        self.http = requests.Session()
        self.http.headers.update(OPENWA_HEADERS)
        self._init_db()
        self.check_connectivity()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    chat_id TEXT PRIMARY KEY,
                    telefono TEXT,
                    openwa_session_id TEXT,
                    history TEXT,
                    status TEXT,
                    last_inbox_id TEXT,
                    updated_at TEXT
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS processed_messages (
                    message_key TEXT PRIMARY KEY,
                    source TEXT,
                    processed_at TEXT
                )
                """
            )
            conn.commit()

    def is_processed(self, message_key: str) -> bool:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT 1 FROM processed_messages WHERE message_key = ?",
                (message_key,),
            ).fetchone()
            return row is not None

    def mark_processed(self, message_key: str, source: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO processed_messages (message_key, source, processed_at)
                VALUES (?, ?, ?)
                """,
                (message_key, source, datetime.now(timezone.utc).isoformat()),
            )
            conn.commit()

    def check_connectivity(self):
        print("[*] Verificando conexiones…")

        # Bridge msg
        try:
            r = requests.get(
                f"{BRIDGE_URL}/api/hermes/health",
                headers=BRIDGE_HEADERS,
                timeout=8,
            )
            if r.status_code == 200:
                print(f"[OK] Bridge msg → {BRIDGE_URL}")
            else:
                print(f"[!] Bridge msg HTTP {r.status_code}: {r.text[:120]}")
        except Exception as e:
            print(f"[!] Bridge msg no alcanzable ({BRIDGE_URL}): {e}")

        # OpenWA
        try:
            r = self.http.get(
                f"{OPENWA_BASE_URL}/sessions",
                params={"status": "CONNECTED", "limit": 20},
                timeout=10,
            )
            if r.status_code == 200:
                data = r.json()
                rows = data if isinstance(data, list) else data.get("data") or data.get("sessions") or []
                connected = [s for s in rows if isinstance(s, dict)]
                print(f"[OK] OpenWA → {OPENWA_BASE_URL} ({len(connected)} sesión(es) CONNECTED)")
                if not OPENWA_SESSION_IDS and connected:
                    for s in connected[:5]:
                        sid = s.get("id") or s.get("sessionId")
                        name = s.get("name") or sid
                        print(f"     · {name} → {sid}")
            else:
                print(f"[!] OpenWA HTTP {r.status_code}: {r.text[:200]}")
                print(f"    ¿OPENWA_BASE_URL correcto? Debe ser http://localhost:2785/api")
        except Exception as e:
            print(f"[!] OpenWA no alcanzable ({OPENWA_BASE_URL}): {e}")

        if OPENWA_POLL_ENABLED:
            print("[*] Modo OpenWA directo: ACTIVO (fallback si bridge vacío)")
        else:
            print("[*] Modo OpenWA directo: desactivado (solo bridge msg)")

    def get_conversation(self, chat_id):
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT telefono, openwa_session_id, history, status, last_inbox_id FROM conversations WHERE chat_id = ?",
                (chat_id,),
            ).fetchone()
            if row:
                return {
                    "telefono": row[0],
                    "openwa_session_id": row[1],
                    "history": json.loads(row[2]),
                    "status": row[3],
                    "last_inbox_id": row[4],
                }
        return None

    def save_conversation(self, chat_id, telefono, session_id, history, status, last_inbox_id):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO conversations
                (chat_id, telefono, openwa_session_id, history, status, last_inbox_id, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chat_id,
                    telefono,
                    session_id,
                    json.dumps(history, ensure_ascii=False),
                    status,
                    last_inbox_id,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            conn.commit()

    def call_ollama(self, history):
        messages = [{"role": "system", "content": SYSTEM_PROMPT}] + history
        try:
            response = requests.post(
                OLLAMA_URL,
                json={
                    "model": OLLAMA_MODEL,
                    "messages": messages,
                    "think": OLLAMA_THINK,
                    "stream": False,
                },
                timeout=120,
            )
            response.raise_for_status()
            return response.json()["message"]["content"].strip()
        except Exception as e:
            print(f"[!] Error Ollama: {e}")
            return None

    def poll_inbox_bridge(self):
        url = f"{BRIDGE_URL}/api/hermes/inbox"
        params = {"limit": 50}
        if self.last_poll_ts:
            params["since"] = self.last_poll_ts

        try:
            resp = requests.get(url, headers=BRIDGE_HEADERS, params=params, timeout=10)
            if resp.status_code != 200:
                print(f"[!] Bridge inbox HTTP {resp.status_code}: {resp.text[:200]}")
                return []

            payload = resp.json()
            if not payload.get("success"):
                print(f"[!] Bridge inbox error: {payload}")
                return []

            messages = payload.get("messages") or []
            for m in messages:
                m["source"] = "bridge"
            if messages:
                self.last_poll_ts = messages[-1]["timestamp"]
                print(f"[~] Bridge inbox: {len(messages)} mensaje(s)")
            return messages
        except Exception as e:
            print(f"[!] Error polling bridge: {e}")
            return []

    def resolve_openwa_sessions(self):
        if OPENWA_SESSION_IDS:
            return OPENWA_SESSION_IDS
        try:
            r = self.http.get(
                f"{OPENWA_BASE_URL}/sessions",
                params={"status": "CONNECTED", "limit": 50},
                timeout=10,
            )
            r.raise_for_status()
            data = r.json()
            rows = data if isinstance(data, list) else data.get("data") or data.get("sessions") or []
            ids = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                sid = row.get("id") or row.get("sessionId")
                if sid:
                    ids.append(str(sid))
            return ids
        except Exception as e:
            print(f"[!] No se pudieron listar sesiones OpenWA: {e}")
            return []

    def poll_inbox_openwa(self):
        """Lee mensajes entrantes directo de OpenWA (sin pasar por webhooks msg)."""
        if not OPENWA_POLL_ENABLED:
            return []

        sessions = self.resolve_openwa_sessions()
        if not sessions:
            return []

        found = []
        for session_id in sessions:
            try:
                r = self.http.get(
                    f"{OPENWA_BASE_URL}/sessions/{session_id}/chats",
                    params={"limit": 40},
                    timeout=15,
                )
                if r.status_code >= 400:
                    print(f"[!] OpenWA chats HTTP {r.status_code} sesión={session_id[:8]}…")
                    continue
                data = r.json()
                chats = data if isinstance(data, list) else data.get("data") or data.get("chats") or []

                for chat in chats:
                    if not isinstance(chat, dict):
                        continue
                    chat_id = chat.get("id") or chat.get("chatId")
                    if not chat_id or "@g.us" in str(chat_id):
                        continue
                    unread = safe_int(chat.get("unreadCount"), 0)
                    if unread <= 0:
                        continue

                    enc = quote(str(chat_id), safe="")
                    hr = self.http.get(
                        f"{OPENWA_BASE_URL}/sessions/{session_id}/messages/{enc}/history",
                        params={"limit": 8},
                        timeout=15,
                    )
                    if hr.status_code >= 400:
                        continue
                    hist = hr.json()
                    msgs = hist if isinstance(hist, list) else hist.get("messages") or hist.get("data") or []

                    for wm in reversed(msgs):
                        if not isinstance(wm, dict):
                            continue
                        if wm.get("fromMe") is True:
                            continue
                        if wm.get("isGroup") is True:
                            continue
                        body = (wm.get("body") or wm.get("text") or "").strip()
                        if not body or body.lower() == "[unknown]":
                            continue

                        msg_id = wm.get("id") or wm.get("messageId") or wm.get("waMessageId")
                        if isinstance(msg_id, dict):
                            msg_id = msg_id.get("_serialized") or msg_id.get("id")
                        msg_id = str(msg_id or f"{chat_id}_{body[:24]}")
                        message_key = f"{session_id}:{chat_id}:{msg_id}"
                        if self.is_processed(message_key):
                            continue

                        found.append(
                            {
                                "source": "openwa",
                                "id": f"openwa_{session_id}_{msg_id}",
                                "message_key": message_key,
                                "messageId": msg_id,
                                "timestamp": wa_ts_to_iso(wm.get("timestamp")),
                                "openwaSessionId": session_id,
                                "chatId": chat_id,
                                "telefono": phone_from_chat_id(chat_id),
                                "contactName": chat.get("name") or wm.get("pushName") or "Cliente",
                                "body": body,
                                "fromMe": False,
                                "isGroup": False,
                                "autoReplyHandled": False,
                            }
                        )
                        break
            except OSError as e:
                print(
                    f"[!] OpenWA poll sesión {session_id}: {e} "
                    f"(¿OpenWA en {OPENWA_BASE_URL}? prueba 127.0.0.1 en vez de localhost)"
                )
            except requests.RequestException as e:
                print(f"[!] OpenWA poll sesión {session_id} (HTTP): {e}")
            except Exception as e:
                print(f"[!] OpenWA poll sesión {session_id}: {type(e).__name__}: {e}")

        if found:
            print(f"[~] OpenWA directo: {len(found)} mensaje(s) sin leer")
        return found

    def poll_all(self):
        bridge = self.poll_inbox_bridge()
        openwa = self.poll_inbox_openwa()

        seen = set()
        merged = []
        for msg in bridge + openwa:
            key = (
                msg.get("message_key")
                or f"{msg.get('openwaSessionId')}:{msg.get('chatId')}:{msg.get('messageId') or msg.get('id')}"
            )
            if key in seen:
                continue
            seen.add(key)
            merged.append(msg)
        return merged

    def send_whatsapp(self, session_id, chat_id, text):
        try:
            typing_url = f"{OPENWA_BASE_URL}/sessions/{session_id}/chats/typing"
            self.http.post(
                typing_url,
                json={"chatId": chat_id, "state": "typing"},
                timeout=5,
            )
            time.sleep(random.uniform(TYPING_MIN, TYPING_MAX))
        except Exception as e:
            print(f"[~] Typing no crítico: {e}")

        try:
            send_url = f"{OPENWA_BASE_URL}/sessions/{session_id}/messages/send-text"
            resp = self.http.post(
                send_url,
                json={"chatId": chat_id, "text": text},
                timeout=15,
            )
            if resp.status_code >= 400:
                print(f"[!] OpenWA send HTTP {resp.status_code}: {resp.text[:200]}")
                return False
            return True
        except Exception as e:
            print(f"[!] Error enviar WA: {e}")
            return False

    def ack_bridge(self, inbox_id, status, reply_text):
        if not inbox_id or str(inbox_id).startswith("openwa_"):
            return True
        url = f"{BRIDGE_URL}/api/hermes/ack"
        payload = {"ids": [inbox_id], "status": status, "replyMessage": reply_text}
        try:
            resp = requests.post(url, headers=BRIDGE_HEADERS, json=payload, timeout=10)
            if resp.status_code != 200:
                print(f"[!] Ack HTTP {resp.status_code}: {resp.text[:200]}")
                return False
            return True
        except Exception as e:
            print(f"[!] Error ack bridge: {e}")
            return False

    def infer_status(self, reply, current_status):
        reply_l = reply.lower()
        if any(k in reply_l for k in ["no gracias", "no me interesa", "dejen de escribir"]):
            return "lost_lead"
        if any(k in reply_l for k in ["link", "meet", "agendad", "confirmad", "te espero"]):
            return "meeting_scheduled"
        if any(k in reply_l for k in ["horario", "opción", "opciones", "mañana", "jueves"]):
            return "negociando_reunion"
        return current_status or "esperando_respuesta"

    def process_message(self, msg):
        if msg.get("autoReplyHandled"):
            return

        source = msg.get("source") or "bridge"
        inbox_id = msg.get("id")
        message_key = msg.get("message_key") or (
            f"{msg.get('openwaSessionId')}:{msg.get('chatId')}:{msg.get('messageId') or inbox_id}"
        )
        chat_id = msg.get("chatId")
        body = (msg.get("body") or "").strip()
        session_id = msg.get("openwaSessionId")
        telefono = msg.get("telefono")
        contact_name = msg.get("contactName") or "Cliente"

        if self.is_processed(message_key):
            return

        if not chat_id or not session_id or not body:
            print(f"[!] Mensaje incompleto ({source}): {msg}")
            if source == "bridge" and inbox_id:
                self.ack_bridge(inbox_id, "skipped", "")
            else:
                self.mark_processed(message_key, source)
            return

        conv = self.get_conversation(chat_id)
        if conv and conv.get("last_inbox_id") == inbox_id and source == "bridge":
            return

        if conv and conv.get("status") in ("meeting_scheduled", "lost_lead"):
            print(f"[-] {chat_id} en {conv['status']} → skip")
            self.ack_bridge(inbox_id, conv["status"], "")
            self.mark_processed(message_key, source)
            return

        history = conv["history"] if conv else []
        status = conv["status"] if conv else "esperando_respuesta"

        print(f"\n[+] ({source}) {contact_name} ({telefono}): {body!r}")

        history.append({"role": "user", "content": body})

        print("[?] Pensando…")
        reply = self.call_ollama(history)
        if not reply:
            return

        print(f"[>] Mónica: {reply!r}")

        if self.send_whatsapp(session_id, chat_id, reply):
            new_status = self.infer_status(reply, status)
            ack_ok = self.ack_bridge(inbox_id, new_status, reply)
            if ack_ok:
                history.append({"role": "assistant", "content": reply})
                self.save_conversation(
                    chat_id, telefono, session_id, history, new_status, inbox_id or message_key
                )
                self.mark_processed(message_key, source)
                print(f"[OK] Procesado · status={new_status} · fuente={source}")
            else:
                print("[!] Falló ack — se reintentará")
        else:
            print("[!] Falló envío WhatsApp")

    def run(self):
        print(f"[*] Capataz iniciado")
        print(f"    Bridge (entrada): {BRIDGE_URL}")
        print(f"    OpenWA (envío + fallback): {OPENWA_BASE_URL}")
        while True:
            for msg in self.poll_all():
                self.process_message(msg)
            time.sleep(POLLING_INTERVAL)


if __name__ == "__main__":
    CapatazEngine().run()

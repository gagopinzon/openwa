import os
import json
import time
import sqlite3
import random
import requests
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

BRIDGE_URL = os.getenv("HERMES_BRIDGE_URL", "http://127.0.0.1:3445").rstrip("/")
BRIDGE_TOKEN = os.getenv("HERMES_BRIDGE_TOKEN", "").strip()
OPENWA_BASE_URL = os.getenv("OPENWA_BASE_URL", "").rstrip("/")
OPENWA_API_KEY = os.getenv("OPENWA_API_KEY", "").strip()
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434/api/chat")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma2:27b")

POLLING_INTERVAL = int(os.getenv("POLLING_INTERVAL_SEC", 3))
TYPING_MIN = int(os.getenv("TYPING_MIN_SEC", 2))
TYPING_MAX = int(os.getenv("TYPING_MAX_SEC", 5))

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


class CapatazEngine:
    def __init__(self, db_path="capataz_memory.db"):
        require_env("HERMES_BRIDGE_TOKEN", BRIDGE_TOKEN)
        require_env("OPENWA_BASE_URL", OPENWA_BASE_URL)
        require_env("OPENWA_API_KEY", OPENWA_API_KEY)

        self.db_path = db_path
        # None = primera pasada trae todo lo pendiente del inbox
        self.last_poll_ts = None
        self._init_db()

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
            conn.commit()

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
                json={"model": OLLAMA_MODEL, "messages": messages, "stream": False},
                timeout=60,
            )
            response.raise_for_status()
            data = response.json()
            return data["message"]["content"].strip()
        except Exception as e:
            print(f"[!] Error Ollama: {e}")
            return None

    def poll_inbox(self):
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
            if messages:
                self.last_poll_ts = messages[-1]["timestamp"]
                print(f"[~] Inbox: {len(messages)} mensaje(s) nuevo(s)")
            return messages
        except Exception as e:
            print(f"[!] Error polling: {e}")
            return []

    def send_whatsapp(self, session_id, chat_id, text):
        try:
            typing_url = f"{OPENWA_BASE_URL}/sessions/{session_id}/chats/typing"
            requests.post(
                typing_url,
                headers=OPENWA_HEADERS,
                json={"chatId": chat_id, "state": "typing"},
                timeout=5,
            )
            time.sleep(random.uniform(TYPING_MIN, TYPING_MAX))
        except Exception as e:
            print(f"[~] Typing no crítico: {e}")

        try:
            send_url = f"{OPENWA_BASE_URL}/sessions/{session_id}/messages/send-text"
            resp = requests.post(
                send_url,
                headers=OPENWA_HEADERS,
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

    def run(self):
        print(f"[*] Capataz iniciado → bridge {BRIDGE_URL} | OpenWA {OPENWA_BASE_URL}")
        while True:
            messages = self.poll_inbox()
            for msg in messages:
                if msg.get("autoReplyHandled"):
                    continue

                inbox_id = msg.get("id")
                chat_id = msg.get("chatId")
                body = (msg.get("body") or "").strip()
                session_id = msg.get("openwaSessionId")
                telefono = msg.get("telefono")
                contact_name = msg.get("contactName") or "Cliente"

                if not inbox_id or not chat_id or not session_id or not body:
                    print(f"[!] Mensaje incompleto, ack skip: {msg}")
                    self.ack_bridge(inbox_id or "unknown", "skipped", "")
                    continue

                conv = self.get_conversation(chat_id)
                if conv and conv.get("last_inbox_id") == inbox_id:
                    continue

                if conv and conv.get("status") in ("meeting_scheduled", "lost_lead"):
                    print(f"[-] {chat_id} en {conv['status']} → ack skip")
                    self.ack_bridge(inbox_id, conv["status"], "")
                    continue

                history = conv["history"] if conv else []
                status = conv["status"] if conv else "esperando_respuesta"

                print(f"\n[+] {contact_name} ({telefono}): {body!r}")

                history.append({"role": "user", "content": body})

                print("[?] Pensando...")
                reply = self.call_ollama(history)
                if not reply:
                    continue

                print(f"[>] Mónica: {reply!r}")

                if self.send_whatsapp(session_id, chat_id, reply):
                    new_status = self.infer_status(reply, status)
                    if self.ack_bridge(inbox_id, new_status, reply):
                        history.append({"role": "assistant", "content": reply})
                        self.save_conversation(
                            chat_id, telefono, session_id, history, new_status, inbox_id
                        )
                        print(f"[OK] Ack OK · status={new_status}")
                    else:
                        print("[!] Falló ack — se reintentará")
                else:
                    print("[!] Falló envío WhatsApp")

            time.sleep(POLLING_INTERVAL)


if __name__ == "__main__":
    CapatazEngine().run()

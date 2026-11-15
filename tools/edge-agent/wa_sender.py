"""مرسل واتساب لجهاز المطعم — يرسل تنبيهات «سِجل» من رقم المطعم نفسه.

يُربط مرة واحدة بمسح رمز QR من جوال المطعم (واتساب ← الأجهزة المرتبطة ← ربط جهاز)،
ثم يسحب الرسائل المنتظرة من «سِجل» كل بضع ثوانٍ ويرسلها. بلا اشتراك ولا مزوّد خارجي.

    python wa_sender.py            تشغيل دائم (يفتح صورة QR إن لم يكن مربوطاً)
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
QR_FILE = HERE / "whatsapp-qr.png"
SESSION_FILE = HERE / "whatsapp-session.sqlite3"
POLL_SECONDS = 5
SEND_GAP_SECONDS = 2.0  # مهلة بين الرسائل حتى لا يبدو الرقم مُرسِلاً آلياً بكثافة

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("wa-sender")


def load_config() -> dict:
    return json.loads((HERE / "config.json").read_text(encoding="utf-8"))


class Sijil:
    def __init__(self, config: dict):
        self.base = config["serverUrl"].rstrip("/") + "/api"
        self.key = config["agentKey"]
        self.branch = config["branchCode"]

    def exchange(self, state: str, results: list[dict]) -> list[dict]:
        payload = json.dumps({"branchCode": self.branch, "state": state, "results": results}).encode()
        request = urllib.request.Request(
            self.base + "/control/edge/outbox",
            data=payload,
            method="POST",
            headers={"content-type": "application/json", "x-surveillance-key": self.key},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                reply = json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"HTTP {error.code}") from error
        if not reply.get("ok"):
            raise RuntimeError(str(reply.get("error")))
        return reply.get("messages", [])


def main() -> int:
    try:
        from neonize.client import NewClient
        from neonize.events import ConnectedEv, DisconnectedEv, LoggedOutEv
        from neonize.utils import build_jid
        import segno
    except Exception as error:  # noqa: BLE001
        log.error("مكتبة واتساب غير مثبتة — شغّل install-whatsapp.bat أولاً: %s", error)
        return 2

    sijil = Sijil(load_config())
    client = NewClient(str(SESSION_FILE))
    state = {"value": "need_qr"}

    @client.event(ConnectedEv)
    def on_connected(_client, _event):
        state["value"] = "connected"
        QR_FILE.unlink(missing_ok=True)
        log.info("واتساب مربوط ويعمل")

    @client.event(DisconnectedEv)
    def on_disconnected(_client, _event):
        if state["value"] == "connected":
            state["value"] = "disconnected"
        log.warning("انقطع اتصال واتساب — يعيد المحاولة تلقائياً")

    @client.event(LoggedOutEv)
    def on_logged_out(_client, _event):
        state["value"] = "need_qr"
        log.warning("أُلغي ربط الجهاز من الجوال — يلزم مسح رمز QR من جديد")

    def on_qr(_client, data: bytes):
        state["value"] = "need_qr"
        try:
            segno.make_qr(data).save(str(QR_FILE), scale=10, border=4)
            log.info("امسح الرمز من جوال المطعم: واتساب ← الأجهزة المرتبطة ← ربط جهاز (%s)", QR_FILE.name)
            if sys.platform == "win32" and not os.environ.get("SIJIL_NO_OPEN"):
                os.startfile(str(QR_FILE))  # type: ignore[attr-defined]
        except Exception as error:  # noqa: BLE001
            log.error("تعذّر حفظ صورة QR: %s", error)

    client.event.qr(on_qr)

    def connect_forever():
        while True:
            try:
                client.connect()  # يبقى متصلاً ولا يعود إلا عند انقطاع
            except Exception as error:  # noqa: BLE001
                log.warning("تعذّر الاتصال بواتساب (%s) — إعادة المحاولة بعد 30 ث", str(error)[:120])
            if state["value"] == "connected":
                state["value"] = "disconnected"
            time.sleep(30)

    threading.Thread(target=connect_forever, daemon=True, name="whatsapp").start()

    results: list[dict] = []
    while True:
        try:
            messages = sijil.exchange(state["value"], results)
            results = []
        except Exception as error:  # noqa: BLE001
            log.warning("تعذّر الاتصال بـ«سِجل»: %s", error)
            time.sleep(15)
            continue
        for message in messages:
            try:
                client.send_message(build_jid(str(message["phone"])), str(message["text"]))
                results.append({"id": message["id"], "ok": True, "error": ""})
                log.info("أُرسلت الرسالة %s", message["id"])
            except Exception as error:  # noqa: BLE001
                results.append({"id": message["id"], "ok": False, "error": str(error)[:250]})
                log.warning("فشل إرسال الرسالة %s: %s", message["id"], error)
            time.sleep(SEND_GAP_SECONDS)
        if not messages:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    sys.exit(main())

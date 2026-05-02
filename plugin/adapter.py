"""
LINE Platform Adapter for Hermes Agent.

A plugin-based gateway adapter that connects to LINE Messaging API.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import time
from typing import Any, Dict, Optional

try:
    from aiohttp import web, ClientSession
except ImportError:
    web = None
    ClientSession = None

from gateway.platforms.base import (
    BasePlatformAdapter,
    SendResult,
    MessageEvent,
    MessageType,
)
from gateway.session import SessionSource
from gateway.config import PlatformConfig, Platform

logger = logging.getLogger(__name__)

class LineAdapter(BasePlatformAdapter):
    def __init__(self, config, **kwargs):
        platform = Platform("line")
        super().__init__(config=config, platform=platform)
        
        extra = getattr(config, "extra", {}) or {}
        self.channel_access_token = os.getenv("LINE_CHANNEL_ACCESS_TOKEN") or extra.get("channel_access_token", "")
        self.channel_secret = os.getenv("LINE_CHANNEL_SECRET") or extra.get("channel_secret", "")
        self.webhook_port = int(os.getenv("LINE_WEBHOOK_PORT") or extra.get("port", 5003))
        self.webhook_host = os.getenv("LINE_WEBHOOK_HOST") or extra.get("host", "0.0.0.0")
        
        self._runner = None
        self._reply_tokens = {}  # user_id -> replyToken
        self._loading_tasks = {} # user_id -> asyncio.Task
        self._http_session = None

    @property
    def name(self) -> str:
        return "LINE"

    async def connect(self) -> bool:
        if not self.channel_access_token or not self.channel_secret:
            logger.error("LINE: channel_access_token and channel_secret must be configured")
            self._set_fatal_error("config_missing", "Missing LINE config", retryable=False)
            return False

        if not web:
            logger.error("LINE: aiohttp is required. Please install aiohttp.")
            self._set_fatal_error("aiohttp_missing", "aiohttp missing", retryable=False)
            return False

        self._http_session = ClientSession(headers={
            "Authorization": f"Bearer {self.channel_access_token}"
        })

        app = web.Application()
        app.router.add_post("/webhook", self._handle_webhook)
        app.router.add_get("/health", self._handle_health)

        import socket as _socket
        try:
            with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as _s:
                _s.settimeout(1)
                _s.connect(('127.0.0.1', self.webhook_port))
            logger.error('LINE: Port %d already in use.', self.webhook_port)
            return False
        except (ConnectionRefusedError, OSError):
            pass

        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.webhook_host, self.webhook_port)
        await site.start()
        
        self._mark_connected()
        logger.info("LINE: Webhook listening on %s:%s/webhook", self.webhook_host, self.webhook_port)
        return True

    async def disconnect(self) -> None:
        self._mark_disconnected()
        if self._runner:
            await self._runner.cleanup()
            self._runner = None
        if self._http_session:
            await self._http_session.close()
            self._http_session = None
        for task in self._loading_tasks.values():
            task.cancel()
        self._loading_tasks.clear()

    async def _handle_health(self, request):
        return web.json_response({"status": "ok", "platform": "line"})

    async def _handle_webhook(self, request):
        try:
            body = await request.read()
            signature = request.headers.get("x-line-signature", "")
            
            # Verify Signature
            hash = hmac.new(self.channel_secret.encode('utf-8'), body, hashlib.sha256).digest()
            import base64
            expected_signature = base64.b64encode(hash).decode('utf-8')
            
            if not hmac.compare_digest(signature, expected_signature):
                logger.warning("LINE: Invalid signature")
                return web.Response(status=401, text="Invalid signature")
            
            payload = json.loads(body.decode('utf-8'))
            events = payload.get("events", [])
            
            for event in events:
                asyncio.create_task(self._process_event(event))
                
            return web.Response(status=200, text="OK")
        except Exception as e:
            logger.error(f"LINE Webhook Error: {e}")
            return web.Response(status=500)

    async def _process_event(self, event):
        if event.get("type") != "message":
            return
            
        source_data = event.get("source", {})
        user_id = source_data.get("userId")
        if not user_id:
            return
            
        reply_token = event.get("replyToken")
        if reply_token:
            self._reply_tokens[user_id] = reply_token
            
        message = event.get("message", {})
        msg_type = message.get("type")
        message_id = message.get("id")
        
        content = None
        media_urls = []
        media_types = []
        
        if msg_type == "text":
            content = message.get("text", "").strip()
        elif msg_type == "location":
            title = message.get("title", "")
            address = message.get("address", "")
            lat = message.get("latitude")
            lon = message.get("longitude")
            content = f"[位置資訊] {title + ' - ' if title else ''}{address} (緯度: {lat}, 經度: {lon})"
        elif msg_type == "image":
            # Download image
            try:
                url = f"https://api-data.line.me/v2/bot/message/{message_id}/content"
                async with self._http_session.get(url) as resp:
                    if resp.status == 200:
                        image_data = await resp.read()
                        try:
                            from gateway.platforms.base import cache_image_from_bytes
                            cached_path = cache_image_from_bytes(image_data, ext=".jpg")
                            media_urls.append(cached_path)
                            media_types.append("image/jpeg")
                            content = "傳送了一張圖片"
                        except Exception as cache_e:
                            logger.error(f"LINE Image Cache Error: {cache_e}")
                            content = "[圖片下載成功但無法快取]"
                    else:
                        content = f"[圖片讀取失敗 HTTP {resp.status}]"
            except Exception as e:
                logger.error(f"LINE Image Download Error: {e}")
                content = "[圖片讀取失敗]"
        else:
            return
            
        if not content and not media_urls:
            return
            
        # Start loading animation loop
        if user_id in self._loading_tasks:
            self._loading_tasks[user_id].cancel()
            
        async def loading_loop(uid):
            try:
                while True:
                    await self._send_loading(uid)
                    await asyncio.sleep(30)
            except asyncio.CancelledError:
                pass
                
        self._loading_tasks[user_id] = asyncio.create_task(loading_loop(user_id))

        # Dispatch Message
        if not self._message_handler:
            return

        source = self.build_source(
            chat_id=user_id,
            chat_name=user_id,
            chat_type="dm",
            user_id=user_id,
            user_name=user_id,
        )

        evt = MessageEvent(
            text=content,
            message_type=MessageType.PHOTO if msg_type == "image" else MessageType.TEXT,
            source=source,
            message_id=message_id,
            media_urls=media_urls,
            media_types=media_types,
            timestamp=__import__("datetime").datetime.now(),
        )

        await self.handle_message(evt)

    async def _send_loading(self, user_id):
        if not self._http_session:
            return
        url = "https://api.line.me/v2/bot/chat/loading/start"
        payload = {"chatId": user_id, "loadingSeconds": 40}
        try:
            async with self._http_session.post(url, json=payload) as resp:
                pass
        except Exception:
            pass

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        if not self._http_session:
            return SendResult(success=False, error="Not connected")
            
        # Cancel loading animation
        if chat_id in self._loading_tasks:
            self._loading_tasks[chat_id].cancel()
            del self._loading_tasks[chat_id]

        # Check for media attachments from tool use or other platforms
        media_attachment = metadata.get("attachment") if metadata else None
        if media_attachment:
            # Hermes might pass attachments via metadata.
            # But normally it calls send_image.
            pass

        messages = [{"type": "text", "text": content}]
        return await self._send_messages(chat_id, messages)
        
    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if not self._http_session:
            return SendResult(success=False, error="Not connected")
            
        if chat_id in self._loading_tasks:
            self._loading_tasks[chat_id].cancel()
            del self._loading_tasks[chat_id]
            
        messages = [{
            "type": "image",
            "originalContentUrl": image_url,
            "previewImageUrl": image_url
        }]
        if caption:
            messages.append({"type": "text", "text": caption})
            
        return await self._send_messages(chat_id, messages)

    async def _send_messages(self, user_id: str, messages: list) -> SendResult:
        # Use reply token if available
        reply_token = self._reply_tokens.pop(user_id, None)
        
        try:
            if reply_token:
                url = "https://api.line.me/v2/bot/message/reply"
                payload = {
                    "replyToken": reply_token,
                    "messages": messages
                }
            else:
                url = "https://api.line.me/v2/bot/message/push"
                payload = {
                    "to": user_id,
                    "messages": messages
                }
                
            async with self._http_session.post(url, json=payload) as resp:
                resp_text = await resp.text()
                if resp.status == 200:
                    return SendResult(success=True)
                else:
                    logger.error(f"LINE Send Error: {resp.status} {resp_text}")
                    # If replyToken was invalid/expired, try pushMessage as fallback
                    if reply_token and resp.status == 400:
                        return await self._push_fallback(user_id, messages)
                    return SendResult(success=False, error=f"HTTP {resp.status}: {resp_text}")
                    
        except Exception as e:
            logger.error(f"LINE Send Exception: {e}")
            return SendResult(success=False, error=str(e))

    async def _push_fallback(self, user_id: str, messages: list) -> SendResult:
        url = "https://api.line.me/v2/bot/message/push"
        payload = {
            "to": user_id,
            "messages": messages
        }
        try:
            async with self._http_session.post(url, json=payload) as resp:
                if resp.status == 200:
                    return SendResult(success=True)
                else:
                    resp_text = await resp.text()
                    return SendResult(success=False, error=f"HTTP {resp.status}: {resp_text}")
        except Exception as e:
            return SendResult(success=False, error=str(e))

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        pass

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {
            "name": "LINE User",
            "type": "dm",
        }

def check_requirements() -> bool:
    import os
    token = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
    secret = os.getenv("LINE_CHANNEL_SECRET", "")
    return bool(token and secret)

def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    token = os.getenv("LINE_CHANNEL_ACCESS_TOKEN") or extra.get("channel_access_token", "")
    secret = os.getenv("LINE_CHANNEL_SECRET") or extra.get("channel_secret", "")
    return bool(token and secret)

def is_connected(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    token = os.getenv("LINE_CHANNEL_ACCESS_TOKEN") or extra.get("channel_access_token", "")
    secret = os.getenv("LINE_CHANNEL_SECRET") or extra.get("channel_secret", "")
    return bool(token and secret)

def interactive_setup() -> None:
    from hermes_cli.setup import (
        prompt,
        save_env_value,
        get_env_value,
        print_header,
        print_info,
        print_warning,
        print_success,
    )

    print_header("LINE")
    print_info("Connect Hermes to a LINE Official Account.")
    
    token = prompt("LINE Channel Access Token", default=get_env_value("LINE_CHANNEL_ACCESS_TOKEN") or "")
    if not token:
        print_warning("Access token is required")
        return
    save_env_value("LINE_CHANNEL_ACCESS_TOKEN", token.strip())
    
    secret = prompt("LINE Channel Secret", default=get_env_value("LINE_CHANNEL_SECRET") or "")
    if not secret:
        print_warning("Channel secret is required")
        return
    save_env_value("LINE_CHANNEL_SECRET", secret.strip())
    
    port = prompt("Webhook Port (default 5003)", default=get_env_value("LINE_WEBHOOK_PORT") or "5003")
    if port:
        save_env_value("LINE_WEBHOOK_PORT", port.strip())
        
    print_success("LINE configuration saved")

def register(ctx):
    ctx.register_platform(
        name="line",
        label="LINE",
        adapter_factory=lambda cfg: LineAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"],
        install_hint="No extra packages needed",
        setup_fn=interactive_setup,
        allowed_users_env="LINE_ALLOWED_USERS",
        allow_all_env="LINE_ALLOW_ALL_USERS",
        max_message_length=5000,
        emoji="💬",
        pii_safe=False,
        allow_update_command=True,
        platform_hint=(
            "You are chatting via LINE. Users can send you text, images, and locations. "
            "LINE does NOT support markdown formatting (no bold, italic, or code blocks). "
            "Please use plain text only and keep your formatting clean and readable."
        ),
    )

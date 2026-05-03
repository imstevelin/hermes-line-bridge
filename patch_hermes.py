import os
import sys
import re
import json
from pathlib import Path
import subprocess

def find_hermes_path():
    default_path = Path.home() / ".hermes" / "hermes-agent"
    if default_path.exists():
        return default_path
    try:
        result = subprocess.run(["hermes", "config", "show"], capture_output=True, text=True)
        for line in result.stdout.splitlines():
            if "Install:" in line:
                return Path(line.split("Install:")[1].strip())
    except Exception: pass
    return None

def patch_file(path, search_str, replace_str, name):
    if not path.exists():
        print(f"⚠️ 跳過 {name}: 找不到檔案")
        return False
    content = path.read_text(encoding='utf-8')
    if replace_str in content:
        print(f"✅ {name} 已經修復過。")
        return True
    if search_str in content:
        path.write_text(content.replace(search_str, replace_str), encoding='utf-8')
        print(f"🚀 成功套用修復: {name}")
        return True
    print(f"❌ 無法修復 {name}: 找不到匹配代碼")
    return False

def run_patches():
    root = find_hermes_path()
    if not root:
        print("❌ 找不到 Hermes 安裝路徑")
        return

    # 1. API Server - 413 & Session ID Fix
    api_server = root / "gateway" / "platforms" / "api_server.py"
    patch_file(api_server, 'MAX_REQUEST_BYTES = 1_000_000', 'MAX_REQUEST_BYTES = 100_000_000', "API 大檔案支援 (100MB)")
    patch_file(api_server, 'web.Application(middlewares=mws)', 'web.Application(middlewares=mws, client_max_size=MAX_REQUEST_BYTES)', "AIOHTTP 傳輸限制解除")
    
    # 2. Run Agent - Multimodal Save Fix
    run_agent = root / "run_agent.py"
    old_save = """                self._session_db.append_message(
                    session_id=self.session_id,
                    role=role,
                    content=content,
                    tool_name=msg.get("tool_name"),"""
    new_save = """                # CRITICAL: JSON-serialize multimodal content for DB stability
                db_content = content
                if isinstance(content, list):
                    try:
                        import json as _json
                        db_content = _json.dumps(content, ensure_ascii=False)
                    except Exception: pass

                self._session_db.append_message(
                    session_id=self.session_id,
                    role=role,
                    content=db_content,
                    tool_name=msg.get("tool_name"),"""
    patch_file(run_agent, old_save, new_save, "多模態訊息存檔修復")

    # 4. Auxiliary Client - Base URL Fix
    aux_client = root / "agent" / "auxiliary_client.py"
    old_aux = """        base_url = _to_openai_base_url(
            str(creds.get("base_url", "")).strip().rstrip("/") or pconfig.inference_base_url
        )"""
    new_aux = """        raw_base_url = (
            str(creds.get("base_url", "")).strip().rstrip("/")
            or pconfig.inference_base_url
        )
        # If we explicitly want Anthropic mode, or the URL indicates it,
        # don't rewrite to /v1 yet. _wrap_if_needed handles it.
        if (locals().get("api_mode") == "anthropic_messages" or 
            _endpoint_speaks_anthropic_messages(raw_base_url)):
            base_url = raw_base_url
        else:
            base_url = _to_openai_base_url(raw_base_url)"""
    patch_file(aux_client, old_aux, new_aux, "輔助客戶端 Base URL 修復")

if __name__ == "__main__":
    print("🔍 正在修復 Hermes Agent 核心 Bug...")
    run_patches()
    print("\n✨ 所有核心修復已完成！請記得重啟 Hermes Gateway。")

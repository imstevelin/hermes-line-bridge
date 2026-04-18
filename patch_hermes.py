import os
import sys
from pathlib import Path
import subprocess

def find_api_server_path():
    # 嘗試預設的源碼安裝路徑
    default_path = Path.home() / ".hermes" / "hermes-agent" / "gateway" / "platforms" / "api_server.py"
    if default_path.exists():
        return default_path
        
    # 嘗試透過 hermes CLI 尋找安裝路徑
    try:
        result = subprocess.run(["hermes", "config", "show"], capture_output=True, text=True)
        for line in result.stdout.splitlines():
            if "Install:" in line:
                install_dir = line.split("Install:")[1].strip()
                api_server_path = Path(install_dir) / "gateway" / "platforms" / "api_server.py"
                if api_server_path.exists():
                    return api_server_path
    except Exception:
        pass
        
    print("❌ 無法自動找到 api_server.py，請確認您已正確安裝 Hermes Agent。")
    return None

def apply_patch(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 檢查是否已經打過補丁
    if "final_session_id" in content and "getattr(agent, \"session_id\", session_id)" in content:
        print(f"✅ Hermes Agent 已經修復過，無需再次執行補丁：{file_path}")
        return True

    # 補丁 1: 讓 _run 函數回傳更新後的 session_id
    old_run_return = """            usage = {
                "input_tokens": getattr(agent, "session_prompt_tokens", 0) or 0,
                "output_tokens": getattr(agent, "session_completion_tokens", 0) or 0,
                "total_tokens": getattr(agent, "session_total_tokens", 0) or 0,
            }
            return result, usage

        return await loop.run_in_executor(None, _run)"""
        
    new_run_return = """            usage = {
                "input_tokens": getattr(agent, "session_prompt_tokens", 0) or 0,
                "output_tokens": getattr(agent, "session_completion_tokens", 0) or 0,
                "total_tokens": getattr(agent, "session_total_tokens", 0) or 0,
            }
            return result, usage, getattr(agent, "session_id", session_id)

        return await loop.run_in_executor(None, _run)"""

    if old_run_return in content:
        content = content.replace(old_run_return, new_run_return)

    # 補丁 2: 讓 _compute_completion 接收並傳遞新的 session_id
    old_compute = """        idempotency_key = request.headers.get("Idempotency-Key")
        if idempotency_key:
            fp = _make_request_fingerprint(body, keys=["model", "messages", "tools", "tool_choice", "stream"])
            try:
                result, usage = await _idem_cache.get_or_set(idempotency_key, fp, _compute_completion)
            except Exception as e:
                logger.error("Error running agent for chat completions: %s", e, exc_info=True)
                return web.json_response(
                    _openai_error(f"Internal server error: {e}", err_type="server_error"),
                    status=500,
                )
        else:
            try:
                result, usage = await _compute_completion()
            except Exception as e:
                logger.error("Error running agent for chat completions: %s", e, exc_info=True)
                return web.json_response(
                    _openai_error(f"Internal server error: {e}", err_type="server_error"),
                    status=500,
                )"""

    new_compute = """        idempotency_key = request.headers.get("Idempotency-Key")
        if idempotency_key:
            fp = _make_request_fingerprint(body, keys=["model", "messages", "tools", "tool_choice", "stream"])
            try:
                result, usage, final_session_id = await _idem_cache.get_or_set(idempotency_key, fp, _compute_completion)
            except Exception as e:
                logger.error("Error running agent for chat completions: %s", e, exc_info=True)
                return web.json_response(
                    _openai_error(f"Internal server error: {e}", err_type="server_error"),
                    status=500,
                )
        else:
            try:
                result, usage, final_session_id = await _compute_completion()
            except Exception as e:
                logger.error("Error running agent for chat completions: %s", e, exc_info=True)
                return web.json_response(
                    _openai_error(f"Internal server error: {e}", err_type="server_error"),
                    status=500,
                )"""

    if old_compute in content:
        content = content.replace(old_compute, new_compute)

    # 補丁 3: 更新 HTTP Headers 回傳的 Session ID
    old_return = 'return web.json_response(response_data, headers={"X-Hermes-Session-Id": session_id})'
    new_return = 'return web.json_response(response_data, headers={"X-Hermes-Session-Id": final_session_id})'
    
    if old_return in content:
        content = content.replace(old_return, new_return)

    # 寫入修改
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"✅ 成功修復 Hermes Agent 核心代碼：{file_path}")
    return True

if __name__ == "__main__":
    print("🔍 正在尋找本地的 Hermes Agent 安裝路徑...")
    target_file = find_api_server_path()
    if target_file:
        apply_patch(target_file)
        print("🚀 修復完成！請記得重新啟動您的 Hermes Gateway 服務。")

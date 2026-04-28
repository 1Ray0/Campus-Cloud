"""SSH 遠端執行相關 Pydantic Schemas"""

from __future__ import annotations

from pydantic import BaseModel, Field


class SSHExecRequest(BaseModel):
    """POST /api/v1/ssh/exec 請求體"""

    vmid: int = Field(..., description="目標 VM 或 LXC 的 VMID")
    command: str = Field(..., description="要在遠端執行的 shell 指令或 Python 片段")
    ssh_user: str = Field(default="root", description="SSH 登入帳號（預設 root）")
    ssh_port: int = Field(default=22, ge=1, le=65535, description="SSH 埠號（預設 22）")
    require_confirm: bool = Field(
        default=False,
        description=(
            "是否需要二次確認（False = 直接執行，True = 回傳 pending 等待確認）。"
            "直接呼叫 API 時預設 False；AI Tool 呼叫時預設 True。"
        ),
    )


class SSHExecResult(BaseModel):
    """SSH 指令執行結果"""

    vmid: int = Field(..., description="目標 VMID")
    host: str = Field(..., description="實際連線的 IP 位址")
    ssh_user: str = Field(..., description="SSH 登入帳號")
    command: str = Field(..., description="執行的指令")
    exit_code: int = Field(default=0, description="遠端指令退出碼（0 = 成功）")
    stdout: str = Field(default="", description="標準輸出")
    stderr: str = Field(default="", description="標準錯誤輸出")
    error: str | None = Field(default=None, description="若 SSH 連線/API 發生錯誤，描述錯誤訊息")
    blocked: bool = Field(default=False, description="若指令被黑名單擋下，此欄位為 True")
    block_reason: str | None = Field(default=None, description="黑名單攔截原因")
    pending: bool = Field(
        default=False,
        description="若需要使用者確認（require_confirm=True），回傳 True 等待 /ssh/confirm",
    )
    confirm_token: str | None = Field(
        default=None,
        description="確認 token，呼叫 /api/v1/ssh/confirm 時需帶此 token",
    )


class SSHConfirmRequest(BaseModel):
    """POST /api/v1/ssh/confirm 請求體"""

    confirm_token: str = Field(..., description="由 /ssh/exec 回傳的確認 token")
    approved: bool = Field(..., description="True = 允許執行，False = 拒絕")

from __future__ import annotations

import io

from app.ai.pve_log import ssh_exec as ssh_exec_module


class _FakeChannel:
    def recv_exit_status(self) -> int:
        return 0


class _FakeStream:
    def __init__(self, data: str = "") -> None:
        self._data = data
        self.channel = _FakeChannel()

    def read(self) -> bytes:
        return self._data.encode()


class _FakeSSHClient:
    def __init__(self) -> None:
        self.policy = None

    def set_missing_host_key_policy(self, policy) -> None:
        self.policy = policy

    def connect(self, **_kwargs) -> None:
        return None

    def exec_command(self, *_args, **_kwargs):
        return None, _FakeStream("ok"), _FakeStream("")

    def close(self) -> None:
        return None


def test_ssh_exec_sync_uses_auto_add_policy(monkeypatch) -> None:
    fake_client = _FakeSSHClient()

    class _FakeKey:
        @staticmethod
        def from_private_key(_buffer: io.StringIO):
            return object()

    class _FakeAutoAddPolicy:
        pass

    monkeypatch.setattr(ssh_exec_module.paramiko, "SSHClient", lambda: fake_client)
    monkeypatch.setattr(ssh_exec_module.paramiko, "Ed25519Key", _FakeKey)
    monkeypatch.setattr(ssh_exec_module.paramiko, "AutoAddPolicy", _FakeAutoAddPolicy)

    exit_code, stdout, stderr = ssh_exec_module._ssh_exec_sync(
        host="10.10.0.6",
        port=22,
        username="root",
        private_key_pem="dummy-key",
        command="echo ok",
        timeout=30,
    )

    assert exit_code == 0
    assert stdout == "ok"
    assert stderr == ""
    assert isinstance(fake_client.policy, _FakeAutoAddPolicy)

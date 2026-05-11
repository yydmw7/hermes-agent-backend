# Security Policy

Hermes Agent is intended to run as a local administration tool on trusted machines.

## Supported Use

- Local Windows desktop usage
- Local Linux or WSL Web usage
- Private LAN usage only when protected by your own access control

## Sensitive Data

Do not publish:

- `.env` files
- generated host profiles under `config/hosts/`
- backup archives
- logs containing secrets
- real admin tokens

## Command Execution Boundary

The UI cannot submit arbitrary shell commands. Service operations must be configured in YAML first, then executed through the backend whitelist.

If you expose this tool outside localhost, configure authentication and network restrictions before use.

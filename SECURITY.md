# Security Policy

## Supported Versions

Security fixes are currently applied to the latest published version.

## Reporting a Vulnerability

Please do not open public issues for suspected vulnerabilities.

Use GitHub private vulnerability reporting for this repository if available. If
private reporting is not available, contact the maintainer through a private
channel and include:

- affected package and version
- impact summary
- reproduction steps or proof of concept
- any known mitigations

We will acknowledge valid reports as quickly as possible and coordinate a fix
before public disclosure.

## Package Security Practices

- No install, postinstall, or prepare scripts are shipped for consumers.
- Provider API keys are supplied by host applications and are not stored by Roy.
- Source maps are intentionally published for transparency and easier debugging.
- File and PostgreSQL storage adapters validate filesystem/SQL-sensitive
  identifiers before use.

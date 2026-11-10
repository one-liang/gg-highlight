"""Errors whose message is shown to the user as-is (Traditional Chinese)."""


class UserError(Exception):
    """A failure with a readable message; the CLI prints it in an `error` event."""


def describe(exc: BaseException) -> str:
    """Readable one-line message for any exception."""
    if isinstance(exc, UserError):
        return str(exc)
    text = str(exc).strip()
    name = type(exc).__name__
    return f'{name}: {text}' if text else name

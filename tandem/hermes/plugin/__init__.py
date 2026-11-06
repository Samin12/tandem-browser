"""Native Hermes plugin for Tandem Browser."""

from pathlib import Path


def register(ctx):
    from .cli import handle, setup_parser, slash_status
    from .provider import TandemBrowserProvider

    ctx.register_browser_provider(TandemBrowserProvider())
    ctx.register_cli_command("tandem", help="Set up and check Tandem Browser",
                             setup_fn=setup_parser, handler_fn=handle)
    ctx.register_command("tandem", handler=slash_status, description="Check Tandem Browser")
    ctx.register_skill("tandem-browser", Path(__file__).parent / "skills/tandem-browser/SKILL.md")

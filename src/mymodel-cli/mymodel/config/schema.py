"""Re-exports from loader for explicit schema access.

This keeps the separation between MyModel proxy models (this file / loader.py)
and vLLM SR routing models (mymodel.cli.models).
"""

from mymodel.config.loader import (
    ClassifierConfig,
    ModelIdentity,
    ModalityRoute,
    MyModelConfig,
    PluginConfig,
    ProviderEntry,
    ServerConfig,
    TextRoute,
    TextRouteSignals,
    mask_secret,
    resolve_env_vars,
)

__all__ = [
    "ClassifierConfig",
    "ModelIdentity",
    "ModalityRoute",
    "MyModelConfig",
    "PluginConfig",
    "ProviderEntry",
    "ServerConfig",
    "TextRoute",
    "TextRouteSignals",
    "mask_secret",
    "resolve_env_vars",
]

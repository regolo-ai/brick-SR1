"""Command for `mymodel route "query"` — test routing offline."""

import json
import shutil
import subprocess
import sys
import time

from mymodel.cli.ui import console, print_err, print_routing_result, spinner
from mymodel.config.loader import MyModelConfig


def test_route(query: str, config_path: str):
    """Test routing for a query without starting the server.

    Tries to call the Go binary with --route-test flag first.
    Falls back to keyword matching against text routes.
    """
    try:
        config = MyModelConfig.load(config_path)
    except FileNotFoundError:
        print_err(f"Config file not found: {config_path}")
        sys.exit(1)
    except Exception as e:
        print_err(f"Error loading config: {e}")
        sys.exit(1)

    # Try Go binary first (with spinner)
    go_result = None
    with spinner("Classifying query..."):
        go_result = _try_go_binary(query, config_path)

    if go_result is not None:
        print_routing_result(go_result)
        return

    # Fallback: keyword matching (with spinner)
    with spinner("Matching keywords..."):
        start = time.monotonic()
        result = _keyword_match(query, config)
        elapsed_ms = int((time.monotonic() - start) * 1000)
        result["latency_ms"] = elapsed_ms

    print_routing_result(result)


def _try_go_binary(query: str, config_path: str) -> dict | None:
    """Try running the Go binary with --route-test flag."""
    for binary in ["mymodel-router", "semantic-router", "./semantic-router"]:
        if shutil.which(binary):
            try:
                proc = subprocess.run(
                    [binary, "--route-test", query, "--config", config_path],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if proc.returncode == 0 and proc.stdout.strip():
                    return json.loads(proc.stdout)
            except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
                pass
    return None


def _keyword_match(query: str, config: MyModelConfig) -> dict:
    """Simple keyword matching against text routes."""
    query_lower = query.lower()

    best_route = None
    best_priority = -1
    matched_signals = []

    for route in config.text_routes:
        if route.name == "default":
            continue

        route_signals = []
        keyword_match = False
        domain_match = False

        # Check keywords
        if route.signals.keywords:
            matched_kw = [kw for kw in route.signals.keywords if kw.lower() in query_lower]
            if matched_kw:
                keyword_match = True
                route_signals.append(
                    f"keyword:{route.name} (matched: {', '.join(matched_kw[:3])})"
                )

        # Check domains (simple heuristic)
        if route.signals.domains:
            for domain in route.signals.domains:
                domain_words = domain.lower().replace("_", " ").split()
                if any(dw in query_lower for dw in domain_words):
                    domain_match = True
                    route_signals.append(f"domain:{domain}")
                    break

        # Apply operator
        if route.operator == "OR":
            hit = keyword_match or domain_match
        else:  # AND
            has_kw = bool(route.signals.keywords)
            has_dm = bool(route.signals.domains)
            if has_kw and has_dm:
                hit = keyword_match and domain_match
            elif has_kw:
                hit = keyword_match
            elif has_dm:
                hit = domain_match
            else:
                hit = False

        if hit and route.priority > best_priority:
            best_route = route
            best_priority = route.priority
            matched_signals = route_signals

    # Fallback to default route
    if best_route is None:
        for route in config.text_routes:
            if route.name == "default":
                best_route = route
                break

    if best_route is None and config.text_routes:
        best_route = config.text_routes[0]

    if best_route is None:
        return {
            "query": query,
            "modality": "text",
            "signals": [],
            "route_name": "none",
            "provider": "",
            "model": "",
            "reason": "No routes configured",
        }

    reason = f"operator {best_route.operator}"
    if not matched_signals:
        reason = "default fallback (no signals matched)"

    return {
        "query": query,
        "modality": "text",
        "signals": matched_signals,
        "route_name": best_route.name,
        "provider": best_route.provider,
        "model": best_route.model,
        "reason": f"priority {best_route.priority}, {reason}",
    }

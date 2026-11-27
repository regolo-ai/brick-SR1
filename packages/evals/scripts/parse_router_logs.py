#!/usr/bin/env python3
"""
Parse spatial-router Docker logs and produce a JSONL file with per-request records,
including token estimation via tiktoken, for cost analysis.
"""

import json
import re
from collections import defaultdict

import tiktoken

# ---------------------------------------------------------------------------
# Tokenizer setup – use cl100k_base (GPT-4 / ChatGPT family tokenizer)
# as a reasonable default for estimating tokens on OpenAI-compatible models.
# ---------------------------------------------------------------------------
ENC = tiktoken.get_encoding("cl100k_base")

# ---------------------------------------------------------------------------
# Known model pricing (USD per 1M tokens) – edit as needed
# These are example/placeholder rates; adjust to your actual contract.
# ---------------------------------------------------------------------------
MODEL_PRICING = {
    "gpt-oss-120b": {"input": 3.00, "output": 12.00},
    "gpt-oss-20b": {"input": 0.50, "output": 2.00},
    "qwen3-8b": {"input": 0.10, "output": 0.40},
    "Qwen3-8B": {"input": 0.10, "output": 0.40},
    "qwen3-coder-next": {"input": 0.50, "output": 2.00},
    "deepseek-r1-70b": {"input": 1.00, "output": 4.00},
    "Llama-3.3-70B-Instruct": {"input": 0.80, "output": 3.20},
    "mistral-small-3.2": {"input": 0.30, "output": 1.20},
    "gemma-3-27b-it": {"input": 0.30, "output": 1.20},
}


def estimate_tokens_from_text(text: str) -> int:
    """Estimate token count using tiktoken cl100k_base encoding."""
    if not text:
        return 0
    return len(ENC.encode(text))


def estimate_tokens_from_body_size(body_size: int) -> int:
    """
    Rough estimate: for JSON chat-completion payloads the ratio is ~1 token
    per 4 bytes of body (after accounting for JSON overhead). This is a very
    rough heuristic used only when we don't have the actual text.
    """
    if body_size <= 0:
        return 0
    # subtract ~150 bytes of JSON boilerplate, then ~4 bytes per token
    effective = max(body_size - 150, 0)
    return max(effective // 4, 1)


def parse_json_log_line(line: str):
    """Try to parse a line as JSON. Return dict or None."""
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None


def extract_signal_lists(msg: str) -> dict:
    """
    Parse signal evaluation result string like:
    'Signal evaluation results: keyword=[greeting_simple], embedding=[], domain=[math], ...'
    Returns dict of signal_name -> list of values.
    """
    result = {}
    for m in re.finditer(r"(\w+)=\[([^\]]*)\]", msg):
        key = m.group(1)
        vals = [v.strip() for v in m.group(2).split(",") if v.strip()]
        result[key] = vals
    return result


def extract_modality(msg: str) -> dict:
    """Parse 'Brick modality detected: text=true image=false audio=false'"""
    result = {}
    for m in re.finditer(r"(text|image|audio)=(true|false)", msg):
        result[m.group(1)] = m.group(2) == "true"
    return result


def extract_forwarding_info(msg: str) -> dict:
    """Parse 'Forwarding to backend: ... (streaming=false, body_size=547)'"""
    result = {}
    m = re.search(r"streaming=(true|false)", msg)
    if m:
        result["streaming"] = m.group(1) == "true"
    m = re.search(r"body_size=(\d+)", msg)
    if m:
        result["request_body_size"] = int(m.group(1))
    m = re.search(r"Forwarding to backend:\s+(\S+)", msg)
    if m:
        result["backend_url"] = m.group(1)
    return result


def extract_upstream_response(msg: str) -> dict:
    """Parse 'Upstream response: status=200 content-type=application/json'"""
    result = {}
    m = re.search(r"status=(\d+)", msg)
    if m:
        result["upstream_status"] = int(m.group(1))
    m = re.search(r"content-type=(\S+)", msg)
    if m:
        result["upstream_content_type"] = m.group(1)
    return result


def extract_cache_query(msg: str) -> str | None:
    """
    Parse requestQuery from cache log line.
    handleCaching: requestQuery='...' (len=155), cacheEnabled=false, ...
    """
    m = re.search(r"requestQuery='(.*?)'\s*\(len=\d+\)", msg, re.DOTALL)
    if m:
        return m.group(1)
    return None


def extract_complexity(msg: str) -> dict | None:
    """
    Parse: Complexity rule 'reasoning-complexity': hard_sim=0.236, easy_sim=0.304,
    signal=-0.067, difficulty=medium
    """
    m = re.search(
        r"Complexity rule '([^']+)':\s*hard_sim=([\d.]+),\s*easy_sim=([\d.]+),\s*signal=([-\d.]+),\s*difficulty=(\w+)",
        msg,
    )
    if m:
        return {
            "rule": m.group(1),
            "hard_sim": float(m.group(2)),
            "easy_sim": float(m.group(3)),
            "signal": float(m.group(4)),
            "difficulty": m.group(5),
        }
    return None


def extract_decision_eval(msg: str) -> dict | None:
    """
    Parse: Decision evaluation result: decision=domain_stem, confidence=1.000,
    matched_rules=[domain:math], matched_keywords=[]
    """
    m = re.search(
        r"decision=(\S+?),\s*confidence=([\d.]+),\s*matched_rules=\[([^\]]*)\],\s*matched_keywords=\[([^\]]*)\]",
        msg,
    )
    if m:
        return {
            "decision_name": m.group(1),
            "confidence": float(m.group(2)),
            "matched_rules": [r.strip() for r in m.group(3).split(",") if r.strip()],
            "matched_keywords": [k.strip() for k in m.group(4).split(",") if k.strip()],
        }
    return None


def extract_entropy_reasoning(msg: str) -> dict | None:
    """
    Parse: Entropy-based reasoning decision for this query: true on [gpt-oss-120b]
    model (confidence: 1.000, reason: decision_engine_evaluation)
    """
    m = re.search(
        r"Entropy-based reasoning decision.*?:\s*(true|false)\s+on\s+\[([^\]]+)\]\s+model\s+\(confidence:\s*([\d.]+),\s*reason:\s*([^)]*)\)",
        msg,
    )
    if m:
        return {
            "entropy_reasoning_enabled": m.group(1) == "true",
            "entropy_model": m.group(2),
            "entropy_confidence": float(m.group(3)),
            "entropy_reason": m.group(4).strip(),
        }
    return None


def build_request_key(ts: str, idx: int) -> str:
    """
    Build a unique key for grouping log lines into requests.
    We'll use the routing_decision entries to anchor requests,
    then backfill from surrounding lines.
    """
    return f"{ts}_{idx}"


def process_logs(log_file: str) -> list[dict]:
    """
    Process the brick container log file line by line.
    Group lines into requests by using 'routing_decision' as anchor points,
    then collect associated data from surrounding lines with same timestamp.
    """

    # Step 1: Read all JSON log lines
    all_lines = []
    with open(log_file, encoding="utf-8", errors="replace") as f:
        for line in f:
            entry = parse_json_log_line(line)
            if entry and "ts" in entry:
                all_lines.append(entry)

    # Step 2: Find routing_decision entries as anchors
    # Each routing_decision marks a complete request
    routing_indices = []
    for i, entry in enumerate(all_lines):
        if entry.get("msg") == "routing_decision":
            routing_indices.append(i)

    # Step 3: For each routing_decision, look backwards and forwards
    # to collect all related log lines (same timestamp window)
    requests = []

    for ri in routing_indices:
        anchor = all_lines[ri]
        anchor_ts = anchor.get("ts", "")

        record = {
            "timestamp": anchor_ts,
            "request_id": anchor.get("request_id", ""),
            "original_model": anchor.get("original_model", ""),
            "selected_model": anchor.get("selected_model", ""),
            "decision": anchor.get("decision", ""),
            "reasoning_enabled": anchor.get("reasoning_enabled", False),
            "reasoning_effort": anchor.get("reasoning_effort", ""),
            "routing_latency_ms": anchor.get("routing_latency_ms", 0),
            "reason_code": anchor.get("reason_code", ""),
        }

        # Collect related lines: scan backwards from anchor until timestamp changes
        related = []
        for j in range(ri, max(ri - 50, -1), -1):
            if all_lines[j].get("ts") == anchor_ts:
                related.append(all_lines[j])
            else:
                break
        # Also scan forward briefly for the forward.go lines
        for j in range(ri + 1, min(ri + 5, len(all_lines))):
            if all_lines[j].get("ts") == anchor_ts:
                related.append(all_lines[j])
            else:
                break

        # Extract data from related lines
        for entry in related:
            msg = entry.get("msg", "")
            caller = entry.get("caller", "")

            # Modality
            if "multimodal.go" in caller:
                record.update(extract_modality(msg))

            # Signals (from classifier.go:1597)
            if "classifier.go:1597" in caller and "Signal evaluation results" in msg:
                signals = extract_signal_lists(msg)
                record["signals_keyword"] = signals.get("keyword", [])
                record["signals_embedding"] = signals.get("embedding", [])
                record["signals_domain"] = signals.get("domain", [])
                record["signals_fact_check"] = signals.get("fact_check", [])
                record["signals_user_feedback"] = signals.get("user_feedback", [])
                record["signals_preference"] = signals.get("preference", [])
                record["signals_language"] = signals.get("language", [])
                record["signals_context"] = signals.get("context", [])
                record["signals_complexity"] = signals.get("complexity", [])
                record["signals_modality"] = signals.get("modality", [])

            # Forwarding info
            if "forward.go:25" in caller:
                record.update(extract_forwarding_info(msg))

            # Upstream response
            if "forward.go:77" in caller:
                record.update(extract_upstream_response(msg))

            # Cache / query text
            if "req_filter_cache.go" in caller:
                query = extract_cache_query(msg)
                if query:
                    record["query_text"] = query
                    record["query_token_count"] = estimate_tokens_from_text(query)

            # Complexity
            if "complexity_classifier.go" in caller:
                comp = extract_complexity(msg)
                if comp:
                    if "complexity_rules" not in record:
                        record["complexity_rules"] = []
                    record["complexity_rules"].append(comp)

            # Decision evaluation
            if "classifier.go:1641" in caller:
                dec_eval = extract_decision_eval(msg)
                if dec_eval:
                    record["decision_evaluation"] = dec_eval

            # Entropy reasoning
            if "recorder.go:42" in caller:
                ent = extract_entropy_reasoning(msg)
                if ent:
                    record.update(ent)

            # Endpoint
            if "processor_req_body.go:458" in caller:
                m = re.search(r"Selected endpoint address:\s+(\S+)\s+\(name:\s+(\w+)\)", msg)
                if m:
                    record["endpoint_address"] = m.group(1)
                    record["endpoint_name"] = m.group(2)

            # Modified body length
            if "processor_req_body.go:609" in caller:
                m = re.search(r"modifiedBody length=(\d+)", msg)
                if m:
                    record["modified_body_length"] = int(m.group(1))

        # Token estimation from body size if we don't have query text
        if "query_token_count" not in record and "request_body_size" in record:
            record["query_token_count_estimated"] = estimate_tokens_from_body_size(record["request_body_size"])

        # Cost estimation
        model = record.get("selected_model", "")
        pricing = MODEL_PRICING.get(model)
        if pricing:
            input_tokens = record.get("query_token_count", record.get("query_token_count_estimated", 0))
            # We don't have output tokens from logs, but we can estimate
            # a rough output based on the fact that response was received
            record["estimated_input_tokens"] = input_tokens
            record["input_cost_usd"] = round(input_tokens * pricing["input"] / 1_000_000, 8)
            record["price_per_1m_input_tokens_usd"] = pricing["input"]
            record["price_per_1m_output_tokens_usd"] = pricing["output"]

        requests.append(record)

    return requests


def process_filter_router_logs(log_file: str) -> list[dict]:
    """
    Process the filter-router container logs which have a different format
    (Python logging format, not JSON).
    """
    requests = []
    # These logs have lines like:
    # 2026-02-19 11:19:07,586 - INFO - [CHAT] Model: brick, Stream: False
    # 2026-02-19 11:19:08,488 - INFO - [vLLM-SR] Decision: complex-reasoning, Selected model: gpt-oss-120b
    # 2026-02-19 11:19:08,488 - INFO - [CHAT] Text routed to: hosted_vllm/openai/gpt-oss-120b

    current = {}
    with open(log_file, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            # Parse timestamp
            ts_match = re.match(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})", line)
            if not ts_match:
                continue

            ts = ts_match.group(1)

            # [CHAT] Model line - start of a new request
            m = re.search(r"\[CHAT\] Model:\s+(\S+),\s+Stream:\s+(True|False)", line)
            if m:
                # If we have a previous complete record, save it
                if current.get("selected_model_fr"):
                    requests.append(current)
                current = {
                    "timestamp_fr": ts,
                    "requested_model_fr": m.group(1).rstrip(","),
                    "stream_fr": m.group(2) == "True",
                    "source": "filter-router",
                }
                continue

            # [CHAT] Modality
            m = re.search(r"\[CHAT\] Modality:\s+(\S+)", line)
            if m:
                current["modality_fr"] = m.group(1)
                continue

            # [CHAT] Using selected model
            m = re.search(r"\[CHAT\] Using selected model:\s+(\S+)", line)
            if m:
                current["selected_model_fr"] = m.group(1)
                continue

            # [vLLM-SR] Decision
            m = re.search(r"\[vLLM-SR\] Decision:\s*(.*?),\s*Selected model:\s*(\S*)", line)
            if m:
                current["decision_fr"] = m.group(1).strip()
                current["sr_selected_model_fr"] = m.group(2).strip()
                continue

            # [CHAT] Text routed to
            m = re.search(r"\[CHAT\] Text routed to:\s+(\S+)", line)
            if m:
                current["routed_to_fr"] = m.group(1)
                continue

            # HTTP response
            m = re.search(r'HTTP Request: POST\s+(\S+)\s+"HTTP/[\d.]+ (\d+)', line)
            if m:
                current["upstream_url_fr"] = m.group(1)
                current["upstream_status_fr"] = int(m.group(2))
                continue

            # Client IP
            m = re.search(r'(\d+\.\d+\.\d+\.\d+):\d+ - "POST\s+(\S+)\s+HTTP', line)
            if m:
                current["client_ip_fr"] = m.group(1)
                current["request_path_fr"] = m.group(2)
                continue

    # Don't forget the last record
    if current.get("selected_model_fr"):
        requests.append(current)

    return requests


def main():
    brick_log = "/root/forkGO/raw_logs_brick.txt"
    filter_router_log = "/root/forkGO/raw_logs_filter_router.txt"
    output_file = "/root/forkGO/router_requests.jsonl"

    print(f"Processing brick logs from {brick_log}...")
    brick_requests = process_logs(brick_log)
    print(f"  Found {len(brick_requests)} routing decisions")

    print(f"Processing filter-router logs from {filter_router_log}...")
    fr_requests = process_filter_router_logs(filter_router_log)
    print(f"  Found {len(fr_requests)} filter-router requests")

    # Combine: write brick requests first (they have the richest data),
    # then append filter-router requests with a "source" tag
    all_records = []

    for r in brick_requests:
        r["source"] = "brick-router"
        all_records.append(r)

    for r in fr_requests:
        all_records.append(r)

    # Write JSONL
    with open(output_file, "w", encoding="utf-8") as f:
        for record in all_records:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")

    print(f"\nWrote {len(all_records)} records to {output_file}")

    # Print summary stats
    print("\n--- Summary (brick-router) ---")
    model_counts = defaultdict(int)
    model_tokens = defaultdict(int)
    model_cost = defaultdict(float)
    for r in brick_requests:
        model = r.get("selected_model", "unknown")
        model_counts[model] += 1
        tokens = r.get("estimated_input_tokens", r.get("query_token_count", r.get("query_token_count_estimated", 0)))
        model_tokens[model] += tokens
        model_cost[model] += r.get("input_cost_usd", 0.0)

    print(f"{'Model':<30} {'Requests':>10} {'Est.Input Tokens':>18} {'Est.Input Cost':>16}")
    print("-" * 76)
    for model in sorted(model_counts.keys(), key=lambda m: model_counts[m], reverse=True):
        print(f"{model:<30} {model_counts[model]:>10} {model_tokens[model]:>18,} ${model_cost[model]:>14.6f}")
    print("-" * 76)
    print(
        f"{'TOTAL':<30} {sum(model_counts.values()):>10} {sum(model_tokens.values()):>18,} ${sum(model_cost.values()):>14.6f}"
    )

    # Decision distribution
    print("\n--- Decision Distribution ---")
    decision_counts = defaultdict(int)
    for r in brick_requests:
        dec = r.get("decision", "") or "(fallback/default)"
        decision_counts[dec] += 1
    for dec, cnt in sorted(decision_counts.items(), key=lambda x: x[1], reverse=True):
        print(f"  {dec:<30} {cnt:>6}")


if __name__ == "__main__":
    main()

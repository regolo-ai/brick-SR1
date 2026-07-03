"""Dedup helpers: MinHash+LSH (lessicale) + sentence-transformers + FAISS (semantico)."""

from __future__ import annotations

import re

# Markers used in few-shot templates to separate the final query from the prefix.
QUERY_MARKERS = (
    "Question:",
    "Problem:",
    "Instruction:",
    "Prompt:",
    "Task:",
    "Input:",
)


def extract_actual_query(query: str, max_tail_chars: int = 800) -> str:
    """Strip few-shot prefix dal query, ritorna la query effettiva.

    Heuristic: cerca ultimo marker conosciuto. Se non trova, prende gli ultimi N char.
    """
    if not query:
        return query
    last_pos = -1
    for m in QUERY_MARKERS:
        pos = query.rfind(m)
        if pos > last_pos:
            last_pos = pos
    if last_pos > 0:
        return query[last_pos:]
    return query[-max_tail_chars:]


def normalize_text(text: str) -> str:
    """Lowercase, collapse whitespace, strip punctuation runs."""
    text = text.lower()
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"[^\w\s]+", " ", text)
    return text.strip()


def shingles(text: str, n: int = 5) -> set[str]:
    """Word-level n-gram shingles. n=5 is standard for MinHash near-dedup."""
    words = normalize_text(text).split()
    if len(words) < n:
        return {" ".join(words)} if words else set()
    return {" ".join(words[i : i + n]) for i in range(len(words) - n + 1)}


def minhash_signature(text: str, num_perm: int = 128, n_gram: int = 5):
    """Build MinHash signature from text. Lazy import datasketch."""
    from datasketch import MinHash

    m = MinHash(num_perm=num_perm)
    for sh in shingles(text, n=n_gram):
        m.update(sh.encode("utf-8"))
    return m


def build_lsh_index(
    rows: list[dict],
    threshold: float = 0.75,
    num_perm: int = 128,
    n_gram: int = 5,
    use_actual_query: bool = True,
):
    """Returns (lsh_index, sig_map: {query_id: MinHash}). Strip few-shot if use_actual_query."""
    from datasketch import MinHashLSH

    lsh = MinHashLSH(threshold=threshold, num_perm=num_perm)
    sigs = {}
    for r in rows:
        text = extract_actual_query(r["query"]) if use_actual_query else r["query"]
        m = minhash_signature(text, num_perm=num_perm, n_gram=n_gram)
        lsh.insert(r["query_id"], m)
        sigs[r["query_id"]] = m
    return lsh, sigs


def query_near_duplicates(lsh, sigs: dict, query_id: str) -> list[str]:
    """Return list of query_ids matching given query_id (excluding self)."""
    m = sigs[query_id]
    matches = lsh.query(m)
    return [qid for qid in matches if qid != query_id]


def encode_embeddings(
    texts: list[str], model_name: str = "sentence-transformers/all-mpnet-base-v2", batch_size: int = 32
):
    """Encode texts into normalized embeddings (CPU). Lazy import."""
    import numpy as np
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(model_name, device="cpu")
    emb = model.encode(
        texts,
        batch_size=batch_size,
        show_progress_bar=False,
        convert_to_numpy=True,
        normalize_embeddings=True,
    )
    return emb.astype(np.float32)


def build_faiss_index(embeddings):
    """Build FAISS IndexFlatIP (cosine via normalized vectors)."""
    import faiss

    dim = embeddings.shape[1]
    index = faiss.IndexFlatIP(dim)
    index.add(embeddings)
    return index


def find_semantic_duplicates(
    embeddings,
    threshold: float = 0.92,
    k: int = 10,
) -> list[tuple[int, int, float]]:
    """Return list of (i, j, cosine) pairs with i<j and cosine>=threshold."""
    index = build_faiss_index(embeddings)
    scores, idxs = index.search(embeddings, k=k)
    pairs = []
    for i in range(len(embeddings)):
        for rank in range(k):
            j = int(idxs[i][rank])
            s = float(scores[i][rank])
            if j > i and s >= threshold:
                pairs.append((i, j, s))
    return pairs

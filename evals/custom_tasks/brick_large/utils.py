def doc_to_text(doc):
    """Format a brick_large question for the model (up to 10 choices, A-J)."""
    choices = doc["choices"]
    letters = list("ABCDEFGHIJ")
    options = "\n".join(f"{letters[i]}. {c}" for i, c in enumerate(choices))
    return f"Question: {doc['question']}\n{options}\nAnswer:"

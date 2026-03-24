def doc_to_text(doc):
    """Format a brick_hard question for the model."""
    choices = doc["choices"]
    letters = list("ABCDEFGHIJ")
    options = "\n".join(f"{letters[i]}. {c}" for i, c in enumerate(choices))
    return f"Question: {doc['question']}\n{options}\nAnswer:"

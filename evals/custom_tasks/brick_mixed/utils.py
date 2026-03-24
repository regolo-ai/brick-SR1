def doc_to_text(doc):
    """Format a brick_mixed question for the model.

    Handles both 4-choice (easy, A-D) and 10-choice (hard, A-J) questions.
    """
    choices = doc["choices"]
    letters = list("ABCDEFGHIJ")
    options = "\n".join(f"{letters[i]}. {c}" for i, c in enumerate(choices))
    return f"Question: {doc['question']}\n{options}\nAnswer:"

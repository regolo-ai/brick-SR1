"""Required offline integration checks against the real retained grader sources."""

from brick_evals.graders import ifeval_grader, lcb_grader


def test_both_instruction_registries_are_available_and_enforced():
    assert ifeval_grader._IFEVAL_OK, "IFEval dependencies are missing"
    assert ifeval_grader._IFBENCH_OK, "IFBench dependencies are missing"
    ids = ["change_case:capital_word_frequency", "count:word_count_range"]
    options = [{"capital_frequency": 2, "capital_relation": "at least"}, {"min_words": 2, "max_words": 2}]
    correct, meta = ifeval_grader.grade_ifeval("HELLO WORLD!", ids, options)
    assert correct, meta
    assert ifeval_grader.grade_ifeval("hello world!", ids, options)[0] is False
    assert ifeval_grader.grade_ifeval("HELLO", ids, options)[0] is False


def test_livecodebench_executes_tests_and_rejects_wrong_code():
    assert lcb_grader.AVAILABLE, lcb_grader._IMPORT_ERR
    payload = {"public_tests": [{"input": "2 3\n", "output": "5\n", "testtype": "stdin"}]}
    correct, meta = lcb_grader.grade_lcb("```python\na,b = map(int, input().split())\nprint(a+b)\n```", payload)
    assert correct, meta
    assert lcb_grader.grade_lcb("```python\nprint(0)\n```", payload)[0] is False

# Required instruction-following graders

These Apache-2.0 modules are the exact IFEval and IFBench grading sources used
by the local evaluation baseline, with their copyright notices retained.
`brick_evals.graders.ifeval_grader` imports both registries. The instruction
classes and word lists in their transitive imports implement the configured
Dataset A constraints; no evaluation CLI, remote client or upstream test suite
is copied here.

The local IFBench snapshot includes its existing relative imports and
punctuation-aware word counting. Its implicit NLTK download and source-directory
cache setup have been removed. `scripts/bootstrap_eval_sources.py` installs
checksum-verified language resources explicitly; grading performs no downloads.

Sources: Google Research `instruction_following_eval` and AllenAI `IFBench`.
The files were preserved from the local Brick evaluation workspace because that
workspace did not record their upstream commit identifiers. Do not represent
them as an unmodified upstream release. Their reviewed contents are versioned
with this repository. They are development dependencies, excluded from npm.

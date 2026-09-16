# Third-party notices

## CLIProxyAPI Responses translator

Parts of `apps/router/src/spatial-router/pkg/codextransport` are derived from
the CLIProxyAPI Responses translator at commit
`09a29bd345bc44c473abe7fd07859e32df2ea543`:

<https://github.com/router-for-me/CLIProxyAPI/tree/09a29bd345bc44c473abe7fd07859e32df2ea543/internal/translator/openai/openai/responses>

MIT License

Copyright (c) 2025-2005.9 Luis Pater

Copyright (c) 2025.9-present Router-For.ME

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ModernBERT model assets

The installer retrieves `regolo/modernbert-capability-classifier` at revision
`117a42479a0dd8c126cfb0d02eec0719468e4027`, fine-tuned from
`answerdotai/ModernBERT-base`. The pinned model card declares Apache-2.0.
The model card is downloaded and checksum-verified with the weights.
The runtime preserves Brick's established softmax normalization; the model
card's sigmoid description is not a claim about this runtime's algorithm.

## Native dependency licenses

Each runtime package includes `THIRD_PARTY_LICENSES.txt`, assembled from its
locked Cargo and Go source dependencies. The ug 0.5.0 source archive omits
license files; copies from its recorded upstream commit are retained under
`licenses/ug-0.5.0` for this purpose.

## Evaluation-only instruction graders

`packages/evals/vendor/instruction_following_eval` contains Google Research
IFEval grading modules, Copyright 2026 The Google Research Authors, Apache-2.0.
`packages/evals/vendor/ifbench` contains AllenAI IFBench grading modules,
Copyright 2025 Allen Institute for AI, Apache-2.0. Their license texts and
modification notes are retained beside the sources. Neither is included in the
npm runtime. External BFCL, LiveCodeBench and NLTK resources are downloaded at
pinned revisions by the developer bootstrap; their upstream licenses accompany
the fetched resources.

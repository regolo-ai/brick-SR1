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

## SystemOne model assets

The installer retrieves `massaindustries/brick-systemone-large-v2` at revision
`f6375c086ab5901631f80f3be442a41fb70b3386`, verifies the asset checksums, and stores
weights outside the source repository. Model access and licensing follow its
Hub metadata and upstream model terms. The npm gateway contains no model weights.

## Runtime dependencies

Each runtime package includes `THIRD_PARTY_LICENSES.txt`, assembled from the
locked Go dependency sources. Python, PyTorch, Transformers and optional
FlashAttention are installed in the selected Python environment and retain their
own distribution licenses.

## Evaluation-only instruction graders

`packages/evals/vendor/instruction_following_eval` contains Google Research
IFEval grading modules, Copyright 2026 The Google Research Authors, Apache-2.0.
`packages/evals/vendor/ifbench` contains AllenAI IFBench grading modules,
Copyright 2025 Allen Institute for AI, Apache-2.0. Their license texts and
modification notes are retained beside the sources. Neither is included in the
npm runtime. External BFCL, LiveCodeBench and NLTK resources are downloaded at
pinned revisions by the developer bootstrap; their upstream licenses accompany
the fetched resources.

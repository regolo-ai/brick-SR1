# Math review findings — paper Section 8 (Brick)

Source: `findings.md` (root, Italian), translated to English per AGENTS.md.
The review covers the paper's Brick math section, the worked-example figure,
the architecture diagram, and the router implementation.

## High severity

- The text still calls the `beta=0` case a "quality-only oracle". It is not an
  oracle: it only minimizes the geometric proxy `D_m`, uses no ground-truth
  correctness labels, and with `lambda>0` still penalizes over-capacity.
  Suggestion: use "quality-proxy objective", "capacity-only objective", or
  equivalent wording.
- The paper presents selection as `m*=argmin_m J_m`, but the production code
  applies a tie band (`tie_epsilon=0.03`) and may pick a slightly worse-scoring
  model when it has higher expected success
  (`apps/router/src/spatial-router/pkg/brickrouting/router.go`).
  The paper must either document this tie band or state that the written rule
  is the idealized mathematical version.

## Medium severity

- A figure caption still uses `p(x) in Delta^D`, while the pipeline text was
  corrected to `Delta^{D-1}` with explicit constraints. Align caption and text.
- The worked example claims six probabilities summing to one, but the shown
  values (`0.09, 0.53, 0.09, 0.09, 0.09, 0.09`) sum to `0.98`. Use more
  decimals or state explicitly that the table shows rounded values.
- "Three constraints fix the family" is too strong. Continuity, identity at
  `r=0`, and endpoint targets do not uniquely determine a power law; many
  continuous curves satisfy the same constraints. Reframe the power law as a
  calibrated, interpretable parametric choice, not a mathematical consequence.

## Low severity

- The `coding` row of the mini-table shows dominant capability `crea=0.66`.
  It may be a genuine classifier output, but in a demonstrative table it looks
  inconsistent. Either explain that this is an unconstrained soft
  classification, or pick an example where dimension and dominant capability
  agree.

## Solid parts

- The router math core is consistent with the implementation: difficulty logit
  lift, requirement `p_c z_q`, capacity `p_c logit(s_{m,c})`, asymmetric
  under/over residuals, additive score `J_m=D_m+beta a_m`.
- The preference-knob signs are consistent: at `r=+1`, `beta` and `lambda`
  shrink, favoring more capable models; at `r=-1` they grow, favoring low cost
  and anti-overkill.
- The skill-estimator note distinguishes the production Bayesian estimator from
  the out-of-fold estimator, resolving the old discrepancy.

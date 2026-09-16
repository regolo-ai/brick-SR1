package brickrouting

func (r *Router) scoreModels(probabilities []float64, tauQuery float64, allow map[string]bool) []ModelScore {
	return r.scoreModelsWithConfig(probabilities, tauQuery, allow, r.mathCfg)
}

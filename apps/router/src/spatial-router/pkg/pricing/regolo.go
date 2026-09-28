package pricing

var regoloPrices = map[string]OpenRouterPrice{
	"qwen3.5-9b":             {InputPrice: 0.07, OutputPrice: 0.35},
	"gpt-oss-20b":            {InputPrice: 0.10, OutputPrice: 0.42},
	"apertus-70b":            {InputPrice: 0.40, OutputPrice: 2.10},
	"gemma4-31b":             {InputPrice: 0.40, OutputPrice: 2.10},
	"mistral-small-4-119b":   {InputPrice: 0.50, OutputPrice: 2.10},
	"qwen3-coder-next":       {InputPrice: 0.50, OutputPrice: 2.00},
	"mistral-small3.2":       {InputPrice: 0.50, OutputPrice: 2.20},
	"minimax-m2.5":           {InputPrice: 0.60, OutputPrice: 3.80},
	"Llama-3.3-70B-Instruct": {InputPrice: 0.60, OutputPrice: 2.70},
	"qwen3.5-122b":           {InputPrice: 1.00, OutputPrice: 4.20},
	"gpt-oss-120b":           {InputPrice: 1.00, OutputPrice: 4.20},
}

func GetRegoloPrices() map[string]OpenRouterPrice {
	result := make(map[string]OpenRouterPrice, len(regoloPrices))
	for k, v := range regoloPrices {
		result[k] = v
	}
	return result
}

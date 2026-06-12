package logo

import "fmt"

const (
	colorReset = "\033[0m"
	colorCyan  = "\033[38;2;48;162;255m"
	colorGreen = "\033[38;2;67;207;124m"
	colorWhite = "\033[97m"
)

// PrintBrickLogo prints the Brick router logo with colors.
func PrintBrickLogo() {
	lines := []string{
		"",
		colorCyan + `BBBBB  ` + colorGreen + `RRRRR  ` + colorWhite + `II  CCCCC  K   K` + colorReset,
		colorCyan + `B    B ` + colorGreen + `R    R ` + colorWhite + `II C       K  K ` + colorReset,
		colorCyan + `BBBBB  ` + colorGreen + `RRRRR  ` + colorWhite + `II C       KKK  ` + colorReset,
		colorCyan + `B    B ` + colorGreen + `R   R  ` + colorWhite + `II C       K  K ` + colorReset,
		colorCyan + `BBBBB  ` + colorGreen + `R    R ` + colorWhite + `II  CCCCC  K   K` + colorReset,
		"",
	}
	for _, line := range lines {
		fmt.Println(line)
	}
}

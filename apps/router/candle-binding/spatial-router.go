// Package candle_binding provides Brick's CPU ModernBERT capability classifier.
package candle_binding

/*
#cgo LDFLAGS: -L${SRCDIR}/target/release -lcandle_spatial_router
#include <stdlib.h>
extern int brick_model_load(const char *path, char *error, size_t capacity);
extern int brick_classify(const char *text, float *output, char *error, size_t capacity);
*/
import "C"
import (
	"fmt"
	"strings"
	"unsafe"
)

type ClassResultWithProbs struct {
	Probabilities []float32
}

func InitModernBertClassifier(modelPath string) error {
	if strings.ContainsRune(modelPath, 0) {
		return fmt.Errorf("model path contains NUL")
	}
	path := C.CString(modelPath)
	defer C.free(unsafe.Pointer(path))
	var message [1024]C.char
	if C.brick_model_load(path, &message[0], C.size_t(len(message))) != 0 {
		return fmt.Errorf("ModernBERT: %s", C.GoString(&message[0]))
	}
	return nil
}
func ClassifyModernBertTextWithProbabilities(text string) (ClassResultWithProbs, error) {
	if strings.ContainsRune(text, 0) {
		return ClassResultWithProbs{}, fmt.Errorf("classifier input contains NUL")
	}
	input := C.CString(text)
	defer C.free(unsafe.Pointer(input))
	var values [6]C.float
	var message [1024]C.char
	if C.brick_classify(input, &values[0], &message[0], C.size_t(len(message))) != 0 {
		return ClassResultWithProbs{}, fmt.Errorf("ModernBERT: %s", C.GoString(&message[0]))
	}
	result := ClassResultWithProbs{Probabilities: make([]float32, 6)}
	for i, value := range values {
		result.Probabilities[i] = float32(value)

	}
	return result, nil
}

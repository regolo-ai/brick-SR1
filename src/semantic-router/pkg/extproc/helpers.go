package extproc

import "strings"

// extractResponseIDFromPath extracts the response ID from a path like /v1/responses/{id}
func extractResponseIDFromPath(path string) string {
	if idx := strings.Index(path, "?"); idx != -1 {
		path = path[:idx]
	}

	prefix := "/v1/responses/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}

	id := strings.TrimPrefix(path, prefix)
	id = strings.TrimSuffix(id, "/")

	if strings.Contains(id, "/") {
		return ""
	}

	if id != "" && strings.HasPrefix(id, "resp_") {
		return id
	}

	return ""
}

// extractResponseIDFromInputItemsPath extracts the response ID from a path like /v1/responses/{id}/input_items
func extractResponseIDFromInputItemsPath(path string) string {
	if idx := strings.Index(path, "?"); idx != -1 {
		path = path[:idx]
	}

	prefix := "/v1/responses/"
	suffix := "/input_items"

	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return ""
	}

	id := strings.TrimPrefix(path, prefix)
	id = strings.TrimSuffix(id, suffix)

	if id != "" && strings.HasPrefix(id, "resp_") {
		return id
	}

	return ""
}

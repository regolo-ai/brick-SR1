package proxy

import (
	"encoding/json"
	"github.com/regolo-ai/brick-SR1/systemone"
	"net/http"
)

// handleDiagSystemOne reports the local inference engine without contacting providers.
func (s *Server) handleDiagSystemOne(w http.ResponseWriter, r *http.Request) {
	info := systemone.Info()
	info["enabled"] = s.cfg != nil && s.cfg.SkillRouter.Enabled
	writeJSON(w, 200, info)
}

func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

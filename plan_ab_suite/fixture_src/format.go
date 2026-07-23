package main

import (
	"fmt"
	"sort"
	"strings"
)

// priorityRank orders priorities for display: high first, then medium, low.
var priorityRank = map[string]int{"high": 0, "medium": 1, "low": 2}

// SortByPriority returns a copy of tasks ordered highest priority first.
// The sort is stable: ties keep insertion order.
func SortByPriority(tasks []*Task) []*Task {
	out := append([]*Task(nil), tasks...)
	sort.SliceStable(out, func(i, j int) bool {
		return priorityRank[out[i].Priority] < priorityRank[out[j].Priority]
	})
	return out
}

// RenderTable renders tasks as a fixed-width text table, highest priority
// first. Done tasks show an "x" marker in the DONE column.
func RenderTable(tasks []*Task) string {
	var b strings.Builder
	b.WriteString("ID        PRI     DONE  TITLE\n")
	for _, t := range SortByPriority(tasks) {
		status := " "
		if t.Done {
			status = "x"
		}
		b.WriteString(fmt.Sprintf("%-8s  %-6s  [%s]   %s\n", t.ID, t.Priority, status, t.Title))
	}
	return b.String()
}

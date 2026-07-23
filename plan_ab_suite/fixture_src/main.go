package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
)

// stateFile is where the CLI persists tasks between invocations, relative to
// the current working directory.
const stateFile = "tasks.json"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	store := NewStore()
	if err := loadState(store); err != nil {
		fatal(err)
	}

	cmd, args := os.Args[1], os.Args[2:]
	switch cmd {
	case "add":
		fs := flag.NewFlagSet("add", flag.ExitOnError)
		pri := fs.String("p", "medium", "priority: low, medium or high")
		_ = fs.Parse(args)
		rest := fs.Args()
		if len(rest) < 2 {
			usage()
			os.Exit(2)
		}
		if err := store.Add(rest[0], rest[1], *pri); err != nil {
			fatal(err)
		}
		if err := saveState(store); err != nil {
			fatal(err)
		}
	case "list":
		fs := flag.NewFlagSet("list", flag.ExitOnError)
		page := fs.Int("page", 1, "1-based page number")
		_ = fs.Parse(args)
		fmt.Print(RenderTable(store.List(*page)))
	case "done":
		if len(args) < 1 {
			usage()
			os.Exit(2)
		}
		if err := store.Complete(args[0]); err != nil {
			fatal(err)
		}
		if err := saveState(store); err != nil {
			fatal(err)
		}
	case "serve":
		fs := flag.NewFlagSet("serve", flag.ExitOnError)
		addr := fs.String("addr", ":8080", "listen address")
		_ = fs.Parse(args)
		fmt.Println("taskman listening on", *addr)
		if err := http.ListenAndServe(*addr, NewMux(store)); err != nil {
			fatal(err)
		}
	default:
		usage()
		os.Exit(2)
	}
}

// loadState restores tasks from stateFile if it exists.
func loadState(s *Store) error {
	raw, err := os.ReadFile(stateFile)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var tasks []Task
	if err := json.Unmarshal(raw, &tasks); err != nil {
		return fmt.Errorf("corrupt state file: %w", err)
	}
	for _, t := range tasks {
		if err := s.Add(t.ID, t.Title, t.Priority); err != nil {
			return err
		}
		if t.Done {
			if err := s.Complete(t.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// saveState writes all tasks to stateFile.
func saveState(s *Store) error {
	tasks := make([]Task, 0, len(s.All()))
	for _, t := range s.All() {
		tasks = append(tasks, *t)
	}
	raw, err := json.MarshalIndent(tasks, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(stateFile, raw, 0o644)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: taskman <command> [args]

commands:
  add <id> <title> [-p low|medium|high]   add a task
  list [--page N]                          list tasks (paginated)
  done <id>                                mark a task completed
  serve [-addr :8080]                      start the HTTP API`)
}

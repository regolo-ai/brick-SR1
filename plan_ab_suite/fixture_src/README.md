# taskman

Piccolo task manager di esempio: CLI e API HTTP, zero dipendenze esterne.

- `taskman add <id> <title> [-p low|medium|high]` aggiunge un task
- `taskman list [--page N]` lista paginata (5 task per pagina)
- `taskman done <id>` marca un task come completato
- `taskman serve [-addr :8080]` avvia l'API HTTP (GET/POST /tasks, GET /tasks/{id})

La CLI persiste lo stato in `tasks.json` nella directory corrente.

Test: `go test ./...`

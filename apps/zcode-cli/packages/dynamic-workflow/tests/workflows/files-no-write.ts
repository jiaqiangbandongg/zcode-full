// World inputs are read-only: files has no write().
await files.write("out.txt", "data"); // error

docker run -d -p 2222:22 --rm ssh-server:latest


ssh-copy-id -p 2222 root@localhost
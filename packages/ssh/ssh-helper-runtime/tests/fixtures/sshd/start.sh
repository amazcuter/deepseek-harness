#!/bin/sh
set -eu
ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
install -d -m 700 -o mwf -g mwf /home/mwf/.ssh
install -m 600 -o mwf -g mwf /fixture-key.pub /home/mwf/.ssh/authorized_keys
install -d -m 700 -o mwf -g mwf /home/mwf/workspace
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config

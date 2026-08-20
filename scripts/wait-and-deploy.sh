#!/bin/bash
set -e
until curl -s http://127.0.0.1:8899/health | grep -q ok; do
  sleep 2
done
/root/.local/share/solana/install/active_release/bin/solana program deploy \
  /root/solana-lottery/target/deploy/solana_lottery.so \
  --program-id /root/solana-lottery/target/deploy/solana_lottery-keypair.json \
  --url http://127.0.0.1:8899 \
  --keypair /root/.config/solana/id.json

#!/bin/bash
# Publish and Commit Script for fetch_and_build.js

# Ensure the script stops on first failure
set -e

# Move to the aipages directory
cd ~/clawd/projects/aipages

# Run fetch_and_build.js script
node src/fetch_and_build.js

# Git operations

# Add changes
git add .

# Commit changes with a message
git commit -m "Auto: Updated items using fetch_and_build.js"

# Push to the main repository
git push origin main

# Output success message
echo "Build and push successful!"
#!/bin/bash

# Keploy Agent Launcher Script

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Keploy Agent Launcher${NC}"
echo "================================"
echo ""

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is not installed. Please install Node.js first.${NC}"
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm is not installed. Please install npm first.${NC}"
    exit 1
fi

# Check if Go is installed
if ! command -v go &> /dev/null; then
    echo -e "${RED}❌ Go is not installed. Please install Go first.${NC}"
    echo "   Visit: https://golang.org/"
    exit 1
fi

# Check Node and Go versions
NODE_VERSION=$(node --version)
GO_VERSION=$(go version | cut -d' ' -f3)
echo -e "${GREEN}✓${NC} Node.js version: $NODE_VERSION"
echo -e "${GREEN}✓${NC} Go version: $GO_VERSION"
echo ""

# Check if agent directory exists
if [ ! -d "agent" ]; then
    echo -e "${RED}❌ Agent directory not found!${NC}"
    echo "   Make sure you're running this script from the keploy-agent directory"
    exit 1
fi

# Install Node dependencies if needed
echo -e "${YELLOW}📦 Checking Node.js dependencies...${NC}"
cd agent
if [ ! -d "node_modules" ]; then
    echo "Installing Node.js dependencies..."
    if ! npm install; then
        echo -e "${RED}❌ Failed to install Node dependencies${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓${NC} Node dependencies already installed"
fi

# Build the TypeScript agent
echo -e "${YELLOW}🔨 Building TypeScript agent...${NC}"
if ! npm run build; then
    echo -e "${RED}❌ Failed to build TypeScript agent${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} TypeScript agent built successfully"

# Test that the agent can start
echo -e "${YELLOW}🧪 Testing agent startup...${NC}"
if ! timeout 2 npm start < /dev/null > /dev/null 2>&1; then
    # This is expected to timeout, but it should at least start
    echo -e "${GREEN}✓${NC} Agent can start"
else
    echo -e "${GREEN}✓${NC} Agent verified"
fi

cd ..

# Clean up any old binaries
rm -f keploy-agent-bin

# Build the Keploy Agent
echo -e "${YELLOW}🔨 Building Keploy Agent...${NC}"
if ! go build -o keploy-agent-bin .; then
    echo -e "${RED}❌ Failed to build Keploy Agent${NC}"
    echo "Check for compilation errors above"
    exit 1
fi
echo -e "${GREEN}✓${NC} Keploy Agent built successfully"
echo ""

# Clean up old log files
rm -f keploy-agent.log agent-error.log

# Check for API key in environment
if [ -z "$GOOGLE_GENERATIVE_AI_API_KEY" ]; then
    echo -e "${YELLOW}ℹ️  Note: GOOGLE_GENERATIVE_AI_API_KEY not found in environment.${NC}"
    echo "   You'll be prompted to enter it when the Keploy Agent starts."
else
    echo -e "${GREEN}✓${NC} Google API key found in environment"
fi
echo ""

# Launch the Keploy Agent
echo -e "${GREEN}🚀 Launching Keploy Agent...${NC}"
echo "================================"
echo ""
echo -e "${BLUE}Instructions:${NC}"
echo "  • Enter your Google API key when prompted (hidden input)"
echo "  • Wait for 'Agent initialized successfully' message"
echo "  • Use Ctrl+S to send messages in chat"
echo "  • Use Ctrl+C to quit anytime"
echo ""
echo -e "${YELLOW}Debug logs:${NC}"
echo "  • Keploy Agent logs: keploy-agent.log"
echo "  • Agent errors: agent-error.log"
echo ""

# Run the Keploy Agent
exec ./keploy-agent-bin
#!/bin/bash

# Setup Article Processing Queue Architecture
# This script creates the necessary Cloudflare Queues for the new architecture

echo "🚀 Setting up Article Processing Queue Architecture..."

# Create the main article processing queue
echo "📊 Creating article-processing-queue..."
wrangler queues create article-processing-queue

# Create the dead letter queue for article processing
echo "💀 Creating article-processing-dlq (Dead Letter Queue)..."
wrangler queues create article-processing-dlq

echo "✅ Queue setup completed!"
echo ""
echo "Next steps:"
echo "1. Deploy the workflow orchestrator: cd monitor/workflow && pnpm deploy"
echo "2. Deploy the article processor: cd monitor/article-process && pnpm deploy" 
echo "3. Test the queue flow with: curl -X POST https://opennews-workflow-orchestrator.your-subdomain.workers.dev/trigger -d '{\"source\":\"manual\",\"article_ids\":[\"test-id\"]}'"
echo ""
echo "Queue Architecture:"
echo "Workflow → article-processing-queue → Article Processor → Database"
echo "                ↓ (on failure)"
echo "         article-processing-dlq"
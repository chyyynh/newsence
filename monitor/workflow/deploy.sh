#!/bin/bash

# Deploy script for OpenNews Workflow Orchestrator

echo "🚀 Deploying OpenNews Workflow Orchestrator..."

# Build and deploy the worker
pnpm run deploy

echo "✅ Deployment completed!"
echo ""
echo "📋 Next steps:"
echo "1. Create the workflow_executions table in Supabase:"
echo "   Run the SQL in workflow_executions_table.sql"
echo ""
echo "2. Update RSS Feed Monitor to produce to queue:"
echo "   Add queue producer configuration to rss-feed-monitor/wrangler.jsonc"
echo ""
echo "3. Test the workflow:"
echo "   curl -X POST https://opennews-workflow-orchestrator.your-account.workers.dev/trigger \\"
echo "        -H 'Content-Type: application/json' \\"
echo "        -d '{\"source\": \"manual\"}'"
echo ""
echo "4. Check workflow status:"
echo "   curl https://opennews-workflow-orchestrator.your-account.workers.dev/status"
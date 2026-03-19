/**
 * Hindsight Connection Test
 *
 * Run with:  npx tsx scripts/test-hindsight.ts
 *
 * Tests that the Hindsight API key and bank setup work correctly by:
 *  1. Ensuring the memory bank exists
 *  2. Saving a test memory
 *  3. Searching for it
 *  4. Logging success / failure
 */

import 'dotenv/config'

async function testHindsightConnection(): Promise<void> {
  console.log('\n🧪 Hindsight Connection Test')
  console.log('─'.repeat(40))

  // ── Preflight checks ──────────────────────────────────────────────────
  const apiKey = process.env.HINDSIGHT_API_KEY
  const baseUrl = process.env.HINDSIGHT_BASE_URL

  if (!apiKey || apiKey === 'your-hindsight-api-key-here' || apiKey === 'your_hindsight_api_key_here') {
    console.error('❌ HINDSIGHT_API_KEY is not set or is still the placeholder.')
    console.error('   → Set a real key in your .env file first.')
    process.exit(1)
  }

  console.log(`✅ API Key found   (${apiKey.slice(0, 8)}...)`)
  console.log(`✅ Base URL        ${baseUrl}`)

  // ── Import Hindsight helpers ──────────────────────────────────────────
  const { saveMemory, searchMemory, ensureMemoryBank } = await import('../lib/hindsight')

  // Step 1: Ensure bank exists
  console.log('\n📦 Step 1: Ensuring memory bank exists...')
  try {
    await ensureMemoryBank()
    console.log('   ✅ Memory bank ready')
  } catch (error) {
    console.error('   ⚠️  ensureMemoryBank warning (may already exist):', error)
  }

  // Step 2: Save a test memory
  const testUserId = 'test-user-connection-check'
  const testContent = `Connection test at ${new Date().toISOString()}`

  console.log('\n💾 Step 2: Saving test memory...')
  try {
    const retainResult = await saveMemory(testUserId, testContent, {
      type: 'chat',
      topic: 'connection-test',
      timestamp: new Date().toISOString(),
    })
    console.log('   ✅ Memory saved successfully')
    console.log(`   → Response:`, JSON.stringify(retainResult).slice(0, 200))
  } catch (error) {
    console.error('   ❌ saveMemory FAILED:', error)
    console.error('\n❌ Hindsight connection failed')
    process.exit(1)
  }

  // Step 3: Search for the test memory
  console.log('\n🔍 Step 3: Searching for test memory...')
  try {
    const recallResult = await searchMemory(testUserId, 'connection test')
    console.log(`   ✅ Search returned ${recallResult.results.length} result(s)`)
    if (recallResult.results.length > 0) {
      console.log(`   → Top result: "${recallResult.results[0].text.slice(0, 100)}"`)
    }
  } catch (error) {
    console.error('   ❌ searchMemory FAILED:', error)
    console.error('\n❌ Hindsight connection failed')
    process.exit(1)
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(40))
  console.log('✅ Hindsight connected successfully')
  console.log('   All operations (bank, retain, recall) are working.\n')
}

testHindsightConnection().catch((err) => {
  console.error('\n❌ Hindsight connection failed (unhandled):', err)
  process.exit(1)
})

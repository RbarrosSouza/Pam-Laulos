# Serialize the actual guard module's responses with synthetic model doubles.
# Requiring the test adapter also runs its tests at exit; no Rails/database is used.
require 'json'
require 'digest'
require_relative 'guard_test'

Current.user = OpenStruct.new(id: 1)
scenarios = {
  'actor_check' => { content: '✅', sender_type: 'User', sender_id: 1, deleted: false },
  'same_account_echo_check' => { content: '✅', sender_type: nil, sender_id: nil, deleted: false },
  'other_support_choice' => { content: '👍', sender_type: 'User', sender_id: 2, deleted: false },
  'removed_check' => { content: '', sender_type: 'User', sender_id: 1, deleted: true }
}
fixtures = scenarios.map do |name, values|
  conversation = Conversation.new
  conversation.id = 3
  conversation.contact.identifier = '120000000003@g.us'
  target = Target.new
  target.id = 301; target.conversation_id = 3
  target.content = 'SYNTHETIC ONLY - no patient or real message'
  target.source_id = 'synthetic-original-source'
  target.attachments = [Attachment.new(501, 'file')]
  target.content_attributes.delete('private_unneeded')
  reaction = Reaction.new(401, values[:content],
                          { 'is_reaction' => true, 'in_reply_to' => 301, 'deleted' => values[:deleted] },
                          'sent', 'synthetic-reaction-source', 'outgoing', values[:sender_type], values[:sender_id])
  conversation.rows << reaction
  controller = GuardController.new(conversation, target)
  status, body = controller.send(:pamvet_check_state_result)
  {
    name: name, http_status: status, body: body,
    expected_consumer: name == 'actor_check' || name == 'same_account_echo_check' ? 'own_check_proven' : 'hold_no_dispatch',
    context: {
      document_id: '11111111-1111-4111-8111-111111111111',
      delivery_id: '22222222-2222-4222-8222-222222222222',
      sha256: 'a' * 64, external_message_id: '301', actor_id: 1
    }
  }
end
payload = {
  synthetic_only: true, contract: 'pamvet_check_v1',
  generated_by: 'actual guard module with the documented FakeController adapter',
  guard_sha256: Digest::SHA256.file(File.join(__dir__, 'pamvet_check_guard.rb')).hexdigest,
  fixtures: fixtures
}
filename = ARGV.fetch(0)
File.write(filename, JSON.pretty_generate(payload) + "\n")
puts "Wrote synthetic provider contract fixtures to #{filename}"

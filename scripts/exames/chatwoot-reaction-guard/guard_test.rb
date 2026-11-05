# Exercise the actual additive guard module. Rails routing/ActiveRecord adapters
# are replaced by small doubles; the row lock is a real Ruby Mutex. These tests
# do not claim to run MessageBuilder callbacks, PostgreSQL or WhatsApp transport.
require 'minitest/autorun'
require 'ostruct'
require_relative 'pamvet_check_guard'

module Current
  def self.user
    Thread.current[:pamvet_test_user]
  end
  def self.user=(value)
    Thread.current[:pamvet_test_user] = value
  end
end

Attachment = Struct.new(:id, :file_type)
Reaction = Struct.new(:id, :content, :content_attributes, :status, :source_id, :message_type, :sender_type, :sender_id) do
  def outgoing?; message_type == 'outgoing'; end
  def private?; false; end
end
class Target
  attr_accessor :id, :content, :content_attributes, :status, :source_id, :message_type, :is_private, :attachments, :conversation_id, :account_id, :inbox_id
  def initialize
    @conversation_id = 23; @account_id = 1; @inbox_id = 2
    @id = 2684; @content = 'Private clinical caption, never returned by state'
    @content_attributes = {
      'pamvet_exam_document_id' => '11111111-1111-4111-8111-111111111111',
      'pamvet_exam_delivery_id' => '22222222-2222-4222-8222-222222222222',
      'pamvet_exam_sha256' => 'a' * 64, 'private_unneeded' => 'not serialized'
    }
    @status = 'delivered'; @source_id = 'provider-original'; @message_type = 'outgoing'; @is_private = false
    @attachments = [Attachment.new(51, 'file')]; @mutex = Mutex.new
  end
  def with_lock; @mutex.synchronize { yield }; end
  def private?; is_private; end
  def outgoing?; message_type == 'outgoing'; end
  def reaction?; content_attributes['is_reaction'] == true; end
end
class Conversation
  attr_accessor :id, :account_id, :inbox_id, :contact, :contact_inbox, :inbox, :rows, :creates, :broadcasts, :reloads
  def initialize
    @id = 23; @account_id = 1; @inbox_id = 2
    @contact = OpenStruct.new(identifier: '120000000000000000@g.us', additional_attributes: {})
    @contact_inbox = nil
    @inbox = OpenStruct.new(channel: OpenStruct.new(supports_reactions?: true))
    @rows = []; @creates = 0; @broadcasts = 0; @reloads = 0
  end
  def reload; @reloads += 1; self; end
  def update_columns(*); end
  def dispatch_conversation_updated_event(*); @broadcasts += 1; end
end
class GuardController
  def self.before_action(name, options); @callback = [name, options]; end
  def self.callback; @callback; end
  include PamvetCheckGuard
  attr_accessor :params, :response
  attr_reader :conversation, :target, :rendered
  def initialize(conversation, target)
    @conversation = conversation; @target_message = @target = target
    @params = {}; @response = OpenStruct.new(headers: {})
  end
  def render(json:, status:); @rendered = [status, json]; end
  private
  # Production reads ALL matching outgoing support rows. This double models
  # that external-number scope; a different agent is not an incoming participant.
  # It deliberately does not implement the real ActiveRecord SQL adapter.
  def pamvet_check_own_rows
    @conversation.rows.select do |row|
      attrs = row.content_attributes
      row.outgoing? && attrs['is_reaction'] == true && (attrs['in_reply_to'].to_s == @target_message.id.to_s || attrs['in_reply_to_external_id'] == @target_message.source_id)
    end
  end
  def current_user_reaction
    rows = pamvet_check_own_rows.select do |row|
      row.sender_type == 'User' && row.sender_id == Current.user.id || row.sender_type.nil? && row.sender_id.nil?
    end
    rows.select { |row| reaction_active?(row) }.last || rows.last
  end
  def reaction_active?(row)
    row && !row.content.to_s.strip.empty? && !row.content_attributes['deleted']
  end
  def emoji_payload_valid?(value); ['', '✅', '👍', '❤️'].include?(value); end
  def build_reaction_message!(emoji)
    @conversation.creates += 1
    row = Reaction.new(3000 + @conversation.creates, emoji,
                       { 'is_reaction' => true, 'in_reply_to' => @target_message.id },
                       'sent', nil, 'outgoing', 'User', Current.user.id)
    @conversation.rows << row
    row
  end
end

class CheckGuardTest < Minitest::Test
  def setup
    Current.user = OpenStruct.new(id: 1)
    @conversation = Conversation.new; @target = Target.new
    @controller = GuardController.new(@conversation, @target)
    @expected = expected_from_state
    set_request
  end
  def expected_from_state
    status, body = @controller.send(:pamvet_check_state_result)
    assert_equal 200, status
    scope = body[:scope].transform_keys(&:to_s)
    original = body[:original]
    scope.merge('actor_id' => body[:actor_id],
                'document_id' => '11111111-1111-4111-8111-111111111111',
                'delivery_id' => '22222222-2222-4222-8222-222222222222', 'sha256' => 'a' * 64,
                'source_id' => original[:source_id], 'content_sha256' => original[:content_sha256],
                'attachment_ids' => original[:attachments].map { |item| item[:id] })
  end
  def set_request(controller = @controller, expected = @expected)
    controller.params = { contract: 'pamvet_check_v1', emoji: '✅', expected: expected }
  end
  def ensure_result(controller = @controller); controller.send(:pamvet_ensure_check_result); end
  def add_reaction(emoji = '✅', deleted: false, echo: false, actor: 1, id: nil, status: 'sent', source: 'provider-reaction')
    row = Reaction.new(id || 2900 + @conversation.rows.length, emoji,
                       { 'is_reaction' => true, 'in_reply_to' => @target.id, 'deleted' => deleted },
                       status, source, 'outgoing', echo ? nil : 'User', echo ? nil : actor)
    @conversation.rows << row; row
  end
  def assert_no_create(status, body, expected_status = 409)
    assert_equal expected_status, status
    assert_equal false, body[:dispatch_performed]
    assert_equal 0, @conversation.creates
  end

  def test_only_dedicated_actions_disable_caching
    assert_equal [:pamvet_check_no_store, { only: [:state, :ensure_check] }], GuardController.callback
    @controller.send(:pamvet_check_no_store)
    assert_equal 'no-store', @controller.response.headers['Cache-Control']
  end
  def test_state_is_complete_and_does_not_expose_caption_pdf_urls_or_extra_attributes
    add_reaction
    status, body = @controller.send(:pamvet_check_state_result)
    assert_equal 200, status
    assert_equal 'pamvet_check_v1', body[:contract]
    assert body[:complete]; assert body[:evidence_complete]
    assert_equal 1, body[:own_reactions].size
    assert_equal @target.id, body[:scope][:message_id]
    refute_includes body.to_s, 'Private clinical caption'
    refute_includes body.to_s, 'private_unneeded'
    assert_equal Digest::SHA256.hexdigest(@target.content), body[:original][:content_sha256]
  end
  def test_absence_creates_exactly_one_check_and_normal_repetition_is_noop
    status, body = ensure_result
    assert_equal 201, status; assert_equal 'created', body[:action]; assert body[:dispatch_performed]
    assert_equal 1, @conversation.creates
    status, body = ensure_result
    assert_equal 200, status; assert_equal 'already_present', body[:action]; refute body[:dispatch_performed]
    assert_equal 1, @conversation.creates
  end
  def test_two_concurrent_ensures_share_real_mutex_and_only_one_calls_builder
    other = GuardController.new(@conversation, @target); set_request(other)
    start = Queue.new
    results = [@controller, other].map do |controller|
      Thread.new do
        Current.user = OpenStruct.new(id: 1); start.pop; ensure_result(controller)
      end
    end
    2.times { start << true }
    values = results.map(&:value)
    assert_equal [200, 201], values.map(&:first).sort
    assert_equal 1, @conversation.creates
    assert_equal 1, values.count { |_, body| body[:dispatch_performed] }
    assert_equal '✅', @conversation.rows.first.content
    refute @conversation.rows.first.content_attributes['deleted']
  end
  def test_manual_check_after_state_before_ensure_is_not_toggled
    row = add_reaction
    status, body = ensure_result
    assert_no_create(status, body, 200)
    assert_equal 'already_present', body[:action]
    assert_equal '✅', row.content; refute row.content_attributes['deleted']
  end
  def test_existing_check_pending_provider_ack_is_noop_and_not_enqueued_again
    row = add_reaction(status: 'sent', source: nil)
    status, body = ensure_result
    assert_no_create(status, body, 200)
    assert_nil body[:own_reactions].first[:source_id]
    assert_equal '✅', row.content
  end
  def test_own_other_emoji_is_preserved
    row = add_reaction('👍')
    status, body = ensure_result
    assert_no_create(status, body)
    assert_equal 'PAMVET_CHECK_EXISTING_CHOICE', body[:error_code]
    assert_equal '👍', row.content
  end
  def test_removed_or_deleted_choice_is_not_resurrected
    ['', '✅'].each do |content|
      @conversation.rows.clear
      row = add_reaction(content, deleted: true)
      status, body = ensure_result
      assert_no_create(status, body)
      assert_equal 'PAMVET_CHECK_REMOVED_CHOICE', body[:error_code]
      assert row.content_attributes['deleted']; assert_equal content, row.content
    end
  end
  def test_same_account_echo_and_duplicate_active_checks_are_safe_noops
    add_reaction(echo: true); add_reaction
    status, body = ensure_result
    assert_no_create(status, body, 200)
    assert_equal 2, body[:own_reactions].size
    assert body[:own_reactions].any? { |row| row[:same_account_echo] }
  end
  def test_stale_deleted_echo_does_not_replace_current_active_check
    active = add_reaction; add_reaction('', deleted: true, echo: true)
    status, body = ensure_result
    assert_no_create(status, body, 200)
    assert_equal active.id, body[:current_own_reaction_id]
  end
  def test_other_participant_choice_is_never_modified
    row = add_reaction('👍', actor: 3)
    row.message_type = 'incoming'; row.sender_type = 'Contact'
    status, body = ensure_result
    assert_equal 201, status; assert body[:dispatch_performed]
    assert_equal '👍', row.content
    assert_equal 1, @conversation.creates
  end
  def test_other_support_user_race_after_get_is_held_for_check_and_other_emoji
    ['👍', '✅'].each do |emoji|
      @conversation.rows.clear
      row = add_reaction(emoji, actor: 2)
      status, body = ensure_result
      assert_no_create(status, body)
      assert_equal 'PAMVET_CHECK_OTHER_SUPPORT_CHOICE', body[:error_code]
      assert_equal 'other_support', body[:own_reactions].first[:own_scope]
      assert_nil body[:current_own_reaction_id]
      assert_equal emoji, row.content
      refute row.content_attributes['deleted']
    end
  end
  def test_other_support_deleted_choice_is_not_resurrected
    row = add_reaction('', actor: 2, deleted: true)
    status, body = ensure_result
    assert_no_create(status, body)
    assert_equal 'PAMVET_CHECK_OTHER_SUPPORT_CHOICE', body[:error_code]
    assert row.content_attributes['deleted']
    assert_equal '', row.content
  end
  def test_unknown_outgoing_sender_and_bot_are_held
    [nil, 'AgentBot', 'Contact'].each do |type|
      @conversation.rows.clear
      row = add_reaction('👍', actor: 2); row.sender_type = type
      status, body = ensure_result
      assert_no_create(status, body)
      assert_equal 'PAMVET_CHECK_OTHER_SUPPORT_CHOICE', body[:error_code]
      assert_equal '👍', row.content
    end
  end
  def test_other_support_history_blocks_even_when_actor_check_is_present
    own = add_reaction
    removed_other = add_reaction('', actor: 2, deleted: true)
    status, body = ensure_result
    assert_no_create(status, body)
    assert_equal 'PAMVET_CHECK_OTHER_SUPPORT_CHOICE', body[:error_code]
    assert_equal '✅', own.content
    assert removed_other.content_attributes['deleted']
  end
  def test_scope_and_actor_mismatch_never_create
    %w[account_id inbox_id conversation_id message_id actor_id group_jid].each do |key|
      bad = @expected.merge(key => key == 'group_jid' ? '99999@g.us' : 999)
      set_request(@controller, bad)
      status, body = ensure_result
      assert_no_create(status, body)
    end
  end
  def test_profile_actor_required
    Current.user = nil
    status, body = ensure_result
    assert_no_create(status, body, 403)
    assert_equal 'PAMVET_CHECK_ACTOR_REQUIRED', body[:error_code]
  end
  def test_target_moved_to_another_conversation_after_get_is_held
    @target.conversation_id = 999
    status, body = ensure_result
    assert_no_create(status, body)
    assert_equal 'PAMVET_CHECK_TARGET_SCOPE_MISMATCH', body[:error_code]
  end
  def test_original_changed_between_get_and_ensure_is_held
    @target.content += ' changed'
    status, body = ensure_result
    assert_no_create(status, body)
    assert_equal 'PAMVET_CHECK_ORIGINAL_CHANGED', body[:error_code]
  end
  def test_source_and_attachment_changes_are_held
    @target.source_id = 'different'
    assert_no_create(*ensure_result)
    @target.source_id = 'provider-original'; @target.attachments << Attachment.new(52, 'file')
    assert_no_create(*ensure_result)
  end
  def test_private_deleted_unsupported_or_nonoriginal_targets_never_create
    [proc { @target.is_private = true }, proc { @target.content_attributes['deleted'] = true },
     proc { @target.content_attributes['is_unsupported'] = true }, proc { @target.message_type = 'incoming' },
     proc { @target.content_attributes['is_reaction'] = true }, proc { @target.status = 'failed' }].each do |change|
      @target = Target.new; @controller = GuardController.new(@conversation, @target); set_request
      change.call
      assert_no_create(*ensure_result)
    end
  end
  def test_legacy_reference_is_preserved_without_inventing_missing_sha_tag
    @target.content_attributes = {}
    @target.content = "Legacy caption [EXAM:#{@expected['document_id']}:DELIVERY:#{@expected['delivery_id']}]"
    @expected = expected_from_state; set_request
    status, body = ensure_result
    assert_equal 201, status; assert_equal({}, body[:original][:content_attributes])
  end
  def test_partial_or_wrong_tags_cannot_fall_back_to_legacy_reference
    @target.content = "Legacy [EXAM:#{@expected['document_id']}:DELIVERY:#{@expected['delivery_id']}]"
    @target.content_attributes = { 'pamvet_exam_document_id' => @expected['document_id'] }
    @expected = expected_from_state; set_request
    status, body = ensure_result
    assert_no_create(status, body)
    assert_equal 'PAMVET_CHECK_REFERENCE_MISMATCH', body[:error_code]
  end
  def test_conflicting_reaction_parent_identity_is_held
    row = add_reaction
    row.content_attributes['in_reply_to'] = 999
    row.content_attributes['in_reply_to_external_id'] = @target.source_id
    status, body = ensure_result
    assert_no_create(status, body)
    assert_equal 'PAMVET_CHECK_REACTION_PARENT_MISMATCH', body[:error_code]
  end
  def test_only_check_and_versioned_contract_are_accepted
    [{ emoji: '👍' }, { emoji: '' }, { contract: 'old' }, { expected: {} }].each do |change|
      set_request; @controller.params.merge!(change)
      status, body = ensure_result
      assert_includes [409, 422], status
      assert_equal false, body[:dispatch_performed]
      assert_equal 0, @conversation.creates
    end
  end
  def test_unknown_reaction_text_is_not_leaked_or_overwritten
    row = add_reaction('private unexpected text')
    status, body = ensure_result
    assert_no_create(status, body)
    assert_nil body[:own_reactions].first[:emoji]
    assert body[:own_reactions].first[:invalid_emoji]
    refute_includes body.to_s, row.content
  end
end

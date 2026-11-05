# Additive Pamvet API for the pinned fazer-ai Chatwoot image.
# The existing create/toggle action is deliberately not changed or called.
require 'digest'

module PamvetCheckGuard
  CONTRACT = 'pamvet_check_v1'.freeze
  CHECK = '✅'.freeze
  EXPECTED_KEYS = %w[account_id inbox_id conversation_id message_id actor_id group_jid
                     document_id delivery_id sha256 source_id content_sha256 attachment_ids].freeze
  ORIGINAL_ATTRIBUTE_KEYS = %w[pamvet_exam_document_id pamvet_exam_delivery_id pamvet_exam_sha256 deleted is_reaction].freeze
  UUID = /\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/i
  SHA256 = /\A[0-9a-f]{64}\z/

  def self.included(base)
    base.before_action :pamvet_check_no_store, only: [:state, :ensure_check]
  end

  def state
    status, body = pamvet_check_state_result
    render json: body, status: status
  end

  # Route: POST .../messages/:message_id/reactions/ensure
  # A separate action/path makes an older unpatched server fail with 404.
  def ensure_check
    status, body = pamvet_ensure_check_result
    if body[:dispatch_performed]
      # MessageBuilder's normal after_create_commit sends the one new message.
      # Only refresh the UI here; never enqueue SendReplyJob a second time.
      @conversation.update_columns(updated_at: Time.current)
      @conversation.dispatch_conversation_updated_event(broadcast_metadata: { source: 'reaction_toggle' })
    end
    render json: body, status: status
  end

  private

  def pamvet_check_state_result
    return pamvet_check_error('PAMVET_CHECK_ACTOR_REQUIRED', 403) unless pamvet_check_actor

    @target_message.with_lock do
      @conversation.reload
      error = pamvet_check_original_error
      error ? pamvet_check_error(error, 409) : [200, pamvet_check_snapshot]
    end
  end

  def pamvet_ensure_check_result
    return pamvet_check_error('PAMVET_CHECK_ACTOR_REQUIRED', 403) unless pamvet_check_actor
    unless params[:contract] == CONTRACT && params[:emoji] == CHECK
      return pamvet_check_error('PAMVET_CHECK_CONTRACT_INVALID', 422)
    end

    @target_message.with_lock do
      @conversation.reload
      error = pamvet_check_original_error || pamvet_check_expected_error(pamvet_check_expected)
      next pamvet_check_error(error, 409) if error

      # This is the same target-row lock used by create/toggle. Read the current
      # mutable rows again here, not the earlier GET or an append-only ID cursor.
      own = pamvet_check_own_rows
      selected = current_user_reaction
      # Every outgoing agent uses this inbox's same WhatsApp number. Another
      # User's row is not a participant reaction and must never be overwritten.
      next pamvet_check_error('PAMVET_CHECK_OTHER_SUPPORT_CHOICE', 409, own) unless own.all? { |row| pamvet_check_own_scope(row) != 'other_support' }
      next pamvet_check_error('PAMVET_CHECK_REACTION_PARENT_MISMATCH', 409, own) unless own.all? { |row| pamvet_check_parent_valid?(row) }
      active = own.select { |row| reaction_active?(row) }
      if active.any?
        if active.all? { |row| row.content == CHECK } && selected && reaction_active?(selected) && selected.content == CHECK
          next [200, pamvet_check_snapshot(own).merge(action: 'already_present', dispatch_performed: false)]
        end
        next pamvet_check_error('PAMVET_CHECK_EXISTING_CHOICE', 409, own)
      end
      # A removed/deleted row is an explicit existing choice. Do not resurrect
      # it, even if a negative lookup says there is no active emoji now.
      next pamvet_check_error('PAMVET_CHECK_REMOVED_CHOICE', 409, own) if own.any? || selected

      created = build_reaction_message!(CHECK)
      raise 'PAMVET_CHECK_CREATE_UNPROVEN' unless created.respond_to?(:id) && created.id

      [201, pamvet_check_snapshot.merge(action: 'created', dispatch_performed: true)]
    end
  end

  def pamvet_check_no_store
    response.headers['Cache-Control'] = 'no-store'
  end

  def pamvet_check_actor
    user = Current.user
    user if user && user.respond_to?(:id) && user.id.to_i.positive?
  end

  def pamvet_check_scope
    contact = @conversation.contact
    inbox_contact = @conversation.contact_inbox
    group_jid = contact && contact.identifier
    group_jid = inbox_contact.source_id if group_jid.to_s.empty? && inbox_contact
    group_jid = contact.additional_attributes['jid'] if group_jid.to_s.empty? && contact && contact.additional_attributes.is_a?(Hash)
    {
      account_id: @conversation.account_id,
      inbox_id: @conversation.inbox_id,
      conversation_id: @conversation.id,
      message_id: @target_message.id,
      group_jid: group_jid
    }
  end

  def pamvet_check_original
    attrs = @target_message.content_attributes
    attrs = {} unless attrs.is_a?(Hash)
    selected_attrs = ORIGINAL_ATTRIBUTE_KEYS.each_with_object({}) { |key, result| result[key] = attrs[key] if attrs.key?(key) }
    legacy = @target_message.content.to_s.strip[/\[EXAM:([0-9a-f-]{36}):DELIVERY:([0-9a-f-]{36})\]\z/i]
    {
      id: @target_message.id,
      message_type: @target_message.message_type,
      private: @target_message.private?,
      status: @target_message.status,
      source_id: @target_message.source_id,
      content_sha256: Digest::SHA256.hexdigest(@target_message.content.to_s),
      content_attributes: selected_attrs,
      legacy_reference: legacy,
      attachments: @target_message.attachments.map { |attachment| { id: attachment.id, file_type: attachment.file_type } }
    }
  end

  def pamvet_check_original_error
    unless @target_message.conversation_id == @conversation.id && @target_message.account_id == @conversation.account_id && @target_message.inbox_id == @conversation.inbox_id
      return 'PAMVET_CHECK_TARGET_SCOPE_MISMATCH'
    end
    return 'PAMVET_CHECK_PRIVATE_TARGET' unless @target_message.private? == false
    return 'PAMVET_CHECK_TARGET_TYPE_INVALID' unless @target_message.outgoing? && !@target_message.reaction?
    attrs = @target_message.content_attributes
    return 'PAMVET_CHECK_TARGET_ATTRIBUTES_INVALID' unless attrs.is_a?(Hash)
    return 'PAMVET_CHECK_TARGET_DELETED' if attrs['deleted'] == true
    return 'PAMVET_CHECK_TARGET_UNSUPPORTED' if attrs['is_unsupported'] == true
    channel = @conversation.inbox.channel
    return 'PAMVET_CHECK_CHANNEL_UNSUPPORTED' unless channel.respond_to?(:supports_reactions?) && channel.supports_reactions?
    return 'PAMVET_CHECK_ORIGINAL_UNPROVEN' unless %w[sent delivered read].include?(@target_message.status)
    return 'PAMVET_CHECK_ORIGINAL_UNPROVEN' if @target_message.source_id.to_s.empty?
    return 'PAMVET_CHECK_ORIGINAL_UNPROVEN' unless @target_message.attachments.any? { |attachment| attachment.file_type == 'file' }
    return 'PAMVET_CHECK_GROUP_UNPROVEN' unless pamvet_check_scope[:group_jid].to_s.match?(/\A[0-9]{5,32}@g\.us\z/)

    nil
  end

  def pamvet_check_expected
    value = params[:expected]
    return nil unless value.respond_to?(:[])

    value = value.permit(*EXPECTED_KEYS.reject { |key| key == 'attachment_ids' }, attachment_ids: []).to_h if value.respond_to?(:permit)
    return nil unless value.is_a?(Hash)

    value.each_with_object({}) { |(key, entry), result| result[key.to_s] = entry }
  end

  def pamvet_check_expected_error(expected)
    return 'PAMVET_CHECK_EXPECTED_REQUIRED' unless expected && EXPECTED_KEYS.all? { |key| expected.key?(key) }

    scope = pamvet_check_scope
    %w[account_id inbox_id conversation_id message_id].each do |key|
      value = expected[key].to_s
      return 'PAMVET_CHECK_SCOPE_MISMATCH' unless value.match?(/\A[1-9][0-9]*\z/) && value.to_i == scope[key.to_sym]
    end
    return 'PAMVET_CHECK_ACTOR_MISMATCH' unless expected['actor_id'].to_s.match?(/\A[1-9][0-9]*\z/) && expected['actor_id'].to_i == pamvet_check_actor.id
    return 'PAMVET_CHECK_SCOPE_MISMATCH' unless expected['group_jid'] == scope[:group_jid]
    unless expected['document_id'].is_a?(String) && expected['document_id'].match?(UUID) && expected['delivery_id'].is_a?(String) && expected['delivery_id'].match?(UUID)
      return 'PAMVET_CHECK_REFERENCE_INVALID'
    end
    return 'PAMVET_CHECK_REFERENCE_INVALID' unless expected['sha256'].is_a?(String) && expected['sha256'].match?(SHA256)

    original = pamvet_check_original
    return 'PAMVET_CHECK_ORIGINAL_CHANGED' unless expected['source_id'] == original[:source_id] && expected['content_sha256'] == original[:content_sha256]
    supplied_ids = expected['attachment_ids']
    unless supplied_ids.is_a?(Array) && supplied_ids.all? { |id| id.to_s.match?(/\A[1-9][0-9]*\z/) } && supplied_ids.map(&:to_s).sort == original[:attachments].map { |attachment| attachment[:id].to_s }.sort
      return 'PAMVET_CHECK_ORIGINAL_CHANGED'
    end
    attrs = original[:content_attributes]
    tags = %w[pamvet_exam_document_id pamvet_exam_delivery_id pamvet_exam_sha256]
    if tags.any? { |key| attrs.key?(key) }
      return 'PAMVET_CHECK_REFERENCE_MISMATCH' unless tags.map { |key| attrs[key] } == [expected['document_id'], expected['delivery_id'], expected['sha256']]
    else
      reference = "[EXAM:#{expected['document_id']}:DELIVERY:#{expected['delivery_id']}]"
      return 'PAMVET_CHECK_REFERENCE_MISMATCH' unless original[:legacy_reference] == reference
    end
    nil
  end

  # Despite the legacy JSON key own_reactions, read ALL matching outgoing
  # support rows. Every agent uses the inbox's same external number: hiding
  # User2 would let an absent User1 reaction overwrite User2 on WhatsApp.
  # Incoming participant rows are unrelated to this support-number choice.
  def pamvet_check_own_rows
    json = self.class::CONTENT_ATTRIBUTES_JSONB
    @conversation.messages
                 .where("#{json}->>'is_reaction' = 'true'")
                 .where("(#{json}->>'in_reply_to')::bigint = :message_id OR #{json}->>'in_reply_to_external_id' = :source_id",
                        message_id: @target_message.id, source_id: @target_message.source_id)
                 .where(message_type: Message.message_types[:outgoing])
                 .reorder(created_at: :desc, id: :desc).to_a
  end

  def pamvet_check_own_scope(row)
    return 'actor' if row.sender_type == 'User' && row.sender_id == pamvet_check_actor.id
    return 'same_account_echo' if row.sender_type.nil? && row.sender_id.nil? && row.outgoing?

    'other_support'
  end

  def pamvet_check_parent_valid?(row)
    attrs = row.content_attributes
    return false unless attrs.is_a?(Hash) && attrs['is_reaction'] == true && row.outgoing?

    internal = attrs['in_reply_to']
    external = attrs['in_reply_to_external_id']
    return false if internal && internal.to_s != @target_message.id.to_s
    return false if external && external != @target_message.source_id

    !!(internal || external)
  end

  def pamvet_check_reaction(row)
    attrs = row.content_attributes.is_a?(Hash) ? row.content_attributes : {}
    raw = row.content.to_s
    safe_emoji = emoji_payload_valid?(raw) ? raw : nil
    {
      id: row.id,
      emoji: safe_emoji,
      content: safe_emoji,
      private: row.private?,
      content_attributes: { 'is_reaction' => true, 'deleted' => attrs['deleted'] == true,
                            'in_reply_to' => attrs['in_reply_to'], 'in_reply_to_external_id' => attrs['in_reply_to_external_id'] },
      invalid_emoji: safe_emoji.nil?,
      parent_identity_valid: pamvet_check_parent_valid?(row),
      deleted: attrs['deleted'] == true,
      status: row.status,
      source_id: row.source_id,
      message_type: row.message_type,
      sender: row.sender_type ? { id: row.sender_id, type: row.sender_type.downcase } : nil,
      same_account_echo: pamvet_check_own_scope(row) == 'same_account_echo',
      own_scope: pamvet_check_own_scope(row),
      in_reply_to: attrs['in_reply_to'],
      in_reply_to_external_id: attrs['in_reply_to_external_id']
    }
  end

  def pamvet_check_snapshot(own = nil)
    own ||= pamvet_check_own_rows
    selected = current_user_reaction
    {
      contract: CONTRACT, complete: true, evidence_complete: true,
      actor_id: pamvet_check_actor.id, scope: pamvet_check_scope,
      original: pamvet_check_original,
      own_reactions: own.map { |row| pamvet_check_reaction(row) },
      current_own_reaction_id: selected && selected.id
    }
  end

  def pamvet_check_error(code, status, own = nil)
    body = { contract: CONTRACT, complete: false, evidence_complete: false, action: 'held', dispatch_performed: false, error_code: code }
    body = pamvet_check_snapshot(own).merge(body) if pamvet_check_actor && @target_message
    [status, body]
  end
end

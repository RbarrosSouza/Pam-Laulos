import {normalizeBrazilPhone} from '../whatsapp-intake-runtime.mjs';

export function whatsappProspectivePolicyMaterial(cfg) {
  if(!cfg||typeof cfg!=='object'||Array.isArray(cfg)||!Array.isArray(cfg.authorizedSenders)||!cfg.authorizedSenders.length
    ||cfg.authorizedSenders.length>20||typeof cfg.allowBrazilLegacyMobileAlias!=='boolean')throw new Error('WHATSAPP_AUDIT_POLICY_INVALID');
  const senders=cfg.authorizedSenders.map(normalizeBrazilPhone);
  if(senders.some(value=>!value||value.length!==13)||new Set(senders).size!==senders.length)throw new Error('WHATSAPP_AUDIT_POLICY_INVALID');
  return {senders:senders.sort(),legacy:cfg.allowBrazilLegacyMobileAlias};
}

// Enumerate all individual contacts, but send only proven authorized senders to
// OP05. Unknown senders/ambiguous contact metadata stay in the ledger for review.
export function whatsappProspectiveConversation(row,cfg) {
  const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
  if(!object(row))throw new Error('WHATSAPP_AUDIT_CONVERSATION_UNPROVEN');
  const allowed=whatsappProspectivePolicyMaterial(cfg).senders;
  const contact=row.meta?.sender,objects=[row,contact,row.additional_attributes,contact?.additional_attributes,row.custom_attributes,contact?.custom_attributes];
  const identifiers=[row.contact_inbox?.source_id,contact?.identifier,contact?.phone_number,...objects.filter(object).flatMap(value=>[value.chat_id,value.remote_jid,value.jid,value.identifier,value.source_id])];
  if(objects.some(value=>object(value)&&(value.is_group===true||value.group===true||value.type==='group'||value.contact_type==='group'
    ||typeof value.group_type==='string'&&value.group_type.toLowerCase()==='group'||value.group_id!=null))
    ||identifiers.some(value=>typeof value==='string'&&/@(?:g\.us|broadcast)$/i.test(value)))return 'group';
  if(!object(contact)||(contact.type!=null&&contact.type!=='contact')||!(/^[1-9][0-9]*$/.test(String(contact.id))&&Number.isSafeInteger(Number(contact.id))))return 'review';
  const phone=normalizeBrazilPhone(contact.phone_number);if(!phone)return 'review';
  const aliases=value=>cfg.allowBrazilLegacyMobileAlias&&/^55[1-9][0-9]9[6-9][0-9]{7}$/.test(value)?[value,value.slice(0,4)+value.slice(5)]:[value];
  const match=allowed.find(value=>aliases(value).includes(phone));if(!match)return 'review';
  if(row.contact_inbox!=null){if(!object(row.contact_inbox)||typeof row.contact_inbox.source_id!=='string')return 'review';
    const source=normalizeBrazilPhone(row.contact_inbox.source_id.replace(/@(s\.whatsapp\.net|c\.us)$/,''));
    if(!source||!aliases(match).includes(source))return 'review';}
  return 'approved';
}

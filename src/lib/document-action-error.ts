const fallbackMessage = 'Não foi possível salvar a alteração. Tente novamente; se o problema continuar, avise o suporte.'

// Only reviewed business messages are shown. Database details/hints can contain
// SQL, identifiers or record values and must not be copied into a toast.
const businessMessages = new Map<string, string>([
  ['Original ainda não foi salvo', 'Aguarde o PDF ser salvo no Drive antes de confirmar o cadastro.'],
  ['Documento já vinculado a outro paciente', 'Este exame já está vinculado a outro paciente. Confira o cadastro antes de continuar.'],
  ['Correção deve pertencer ao mesmo paciente da versão anterior', 'A correção precisa pertencer ao mesmo paciente da versão anterior.'],
  ['Resultado já usado no contato/cadastro: registre uma nova versão corrigida', 'Este resultado já foi usado no contato ou no cadastro. Registre uma nova versão corrigida.'],
  ['Tipo do exame necessário para criar resultado externo', 'Preencha o tipo do exame antes de confirmar o cadastro.'],
  ['Itens repetidos', 'Selecione cada item do exame apenas uma vez.'],
  ['Item pertence a outro paciente/tutor ou card arquivado', 'O item selecionado pertence a outro paciente ou tutor, ou está arquivado. Confira a seleção.'],
  ['Item já contém documento de outro paciente', 'O item selecionado já contém um exame de outro paciente. Confira a seleção.'],
  ['Venda vinculada a outro paciente', 'A venda do item selecionado pertence a outro paciente. Confira a seleção.'],
  ['Motivo obrigatório', 'Informe o motivo da classificação.'],
  ['Resultado vinculado deve ser revisado, nunca descartado', 'Este resultado já está vinculado a um cadastro. Revise a identificação antes de continuar.'],
  ['Responsável não autorizado', 'O responsável escolhido não tem acesso aos exames.'],
  ['Confirme o paciente e preserve o resultado antes do contato', 'Confirme o paciente e aguarde o PDF ser salvo antes de registrar o contato.'],
  ['Canal, data e anotação de contato válidos são obrigatórios', 'Confira o canal, a data e a anotação do contato.'],
  ['Selecione somente itens abrangidos por este documento', 'Selecione somente os itens que pertencem a este exame.'],
  ['Envio ao grupo ainda não foi confirmado', 'A entrega no grupo ainda não foi confirmada. Confira a etapa do aviso.'],
  ['Mensagem não corresponde ao envio a conferir', 'A mensagem selecionada não corresponde ao aviso deste exame. Confira o envio no grupo.'],
])

export class DocumentActionError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'DocumentActionError'
    this.code = code
  }
}

export function normalizeDocumentActionError(value: unknown): DocumentActionError {
  if (value instanceof DocumentActionError) return value
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const code = typeof source.code === 'string' && /^[A-Z0-9]{5,10}$/.test(source.code) ? source.code : undefined
  const message = typeof source.message === 'string' ? source.message.trim() : typeof value === 'string' ? value.trim() : ''
  let display = businessMessages.get(message)
  if (code === '40001' || message === 'Documento mudou; atualize a tela') {
    display = 'O exame foi atualizado em outra etapa. Confira os dados atualizados e tente novamente.'
  } else if (code === '22007' || code === '22008') {
    display = 'Confira a data do exame e informe uma data válida antes de salvar.'
  } else if (code === '42501') {
    display = 'Sua conta não tem permissão para esta ação. Confira seu acesso com o administrador.'
  } else if (code === 'PGRST301' || code === 'PGRST302') {
    display = 'Sua sessão não está válida. Entre novamente para continuar.'
  } else if (code === '23503' || code === 'P0002') {
    display = 'O cadastro ou item selecionado não está mais disponível. Atualize os dados e confira a seleção.'
  } else if (!code && /failed to fetch|networkerror|network request failed/i.test(message)) {
    display = 'Não foi possível conectar. Confira sua conexão e tente novamente.'
  }
  return new DocumentActionError(display || fallbackMessage, code)
}

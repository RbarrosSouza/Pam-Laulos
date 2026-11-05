require 'digest'

expected = 'f435c6f148d1a178a0cc73aa77b7c0edb32efbe29f2521866e46b071fc0e8353'
filename = ARGV.fetch(0)
source = File.binread(filename)
abort 'PAMVET_CHECK_ROUTES_BASE_MISMATCH' unless Digest::SHA256.hexdigest(source) == expected
needle = "                  resource :reactions, only: [:create]\n"
abort 'PAMVET_CHECK_ROUTES_AMBIGUOUS' unless source.scan(needle).length == 1
replacement = <<~'ROUTES'
                  resource :reactions, only: [:create] do
                    get :state
                    post 'ensure', action: :ensure_check
                  end
ROUTES
# Preserve the indentation of the Rails route block and every other route.
replacement = replacement.lines.map { |line| '                  ' + line }.join
File.binwrite(filename, source.sub(needle, replacement))

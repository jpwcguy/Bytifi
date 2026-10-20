class Bytifi < Formula
  desc "Encrypt, upload, and decrypt files with Bytifi from the terminal"
  homepage "https://bytifi.com"
  url "https://registry.npmjs.org/bytifi/-/bytifi-0.2.13.tgz"
  sha256 "b1571d0c7a4bda1ca53a94630355a2d9712a35f8c152fd5fb9b60aa3228d4f30"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/bytifi --version")
  end
end

# Regenerate the README GIF (needs vhs and a real key):
#   npm run build && OPENJEV_API_KEY=... vhs demo/demo.tape
Output demo/demo.gif
Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 440
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type "export PS1='$ ' && clear"
Enter
Show

Type "node demo/run.mjs"
Sleep 500ms
Enter
Wait+Screen /tokens|failed/
Sleep 5s

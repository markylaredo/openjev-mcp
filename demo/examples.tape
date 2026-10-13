# Regenerate the examples GIF (needs vhs; it replays the transcripts, so no key or build):
#   vhs demo/examples.tape
Output demo/examples.gif
Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 800
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type "export PS1='$ ' && clear"
Enter
Show

Type "node demo/examples.mjs"
Sleep 500ms
Enter
Wait+Line@2m /^\$\s*$/
Sleep 6s

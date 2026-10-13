# Regenerate the README's jev_batch GIF (needs vhs; it replays the transcript, so no key or build):
#   vhs demo/coop-queue.tape
Output demo/coop-queue.gif
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

Type "node demo/examples.mjs coop-queue"
Sleep 500ms
Enter
Wait+Line@2m /^\$\s*$/
Sleep 6s

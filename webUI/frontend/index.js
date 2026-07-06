
const XForward = document.getElementById("XbuttP")
const XBackwards = document.getElementById("XbuttM")


XForward.addEventListener("click", async function (event) {
    event.preventDefault()
    PingAnswer.textContent = "Pinging"
    const response = await fetch("http://localhost:3300/pingAction", {
        method: "POST",
        headers: {
            "Content-Type" : "application/json"
        }
    })

    const data = await response.json()
    PingAnswer.textContent = data.answer
})




// vizualni funkce
function navMakeUnknownError() {
    
}


function navMakeOkError() {
    
}


function navMakeBadError() {
    
}


function navMakeUnknownStatus() {
    
}


function navMakeOkStatus() {
    
}


function navMakeBadStatus() {
    
}


// --- pozadi mainu ------------------------------------------------------
// Vychozi obrazky lezi v backgrounds-default/ vedle tehle stranky a jsou
// soucasti projektu. Vlastni patri do ../backgrounds/, odkud je bude
// nabizet backend - dokud ten seznam neexistuje, jede se jen z defaultu.
const defaultBackgrounds = [
    "./backgrounds-default/ComplexGraph.png"
]

const backgroundStorageKey = "cncBackground"
const mainElement = document.querySelector("main")


function storedBackground() {
    try {
        return localStorage.getItem(backgroundStorageKey)
    } catch (err) {
        console.warn("[FE] Saved background could not be read:", err)
        return null
    }
}


function rememberBackground(path) {
    try {
        localStorage.setItem(backgroundStorageKey, path)
    } catch (err) {
        console.warn("[FE] Background choice could not be saved:", err)
    }
}


// Az bude endpoint se seznamem z ../backgrounds/, prepise se tahle jedina
// funkce na fetch a spoji se s defaulty. Zbytek se o to nestara.
async function availableBackgrounds() {
    return defaultBackgrounds
}


// Zapamatovat vyber je dulezite: bez toho by se pozadi menilo pri kazdem
// refreshi, coz u panelu, ktery bezi cely den, nikdo nechce.
async function setUpBackground() {
    const saved = storedBackground()

    if (saved) {
        applyBackground(saved)
        return
    }

    const available = await availableBackgrounds()

    if (available.length === 0) {
        console.warn("[FE] No background images are available, main keeps the plain colour.")
        return
    }

    const chosen = available[Math.floor(Math.random() * available.length)]
    rememberBackground(chosen)
    applyBackground(chosen)
}


// Obrazek se dosazuje do promenne, ne primo do background-image - nad nim
// v CSS lezi jeste ztmavovaci vrstva podle --bgBrightness a prime nastaveni
// by ji prepsalo.
function applyBackground(path) {
    document.documentElement.style.setProperty("--bgImage", `url("${path}")`)
    console.log(`[FE] Main background: ${path}`)
}


setUpBackground()


// --- vlna pod kurzorem -------------------------------------------------
// CSS umi nechat hover pozadi vyrust z bodu, ale ten bod mu musi nekdo
// dodat - ::before cte --pointerX a --pointerY. Tenhle posluchac je nastavi
// pri vstupu mysi do tlacitka. Bez nej vlna vyrusta ze stredu, takze kdyz
// se JS nenacte, porad to funguje, jen mene efektne.
//
// pointerenter nebublá, proto je posluchac na dokumentu v zachytavaci fazi
// (treti argument true) - jinak by ho slo navesit jen na kazde tlacitko
// zvlast a znovu po kazde zmene seznamu jobu.
document.addEventListener("pointerenter", (event) => {
    const button = event.target.closest?.("button, .jobListAdd label")

    if (!button) {
        return
    }

    const box = button.getBoundingClientRect()
    button.style.setProperty("--pointerX", `${event.clientX - box.left}px`)
    button.style.setProperty("--pointerY", `${event.clientY - box.top}px`)
}, true)


// --- sipky u policek rychlosti -----------------------------------------
// Nativni sipky jsou schovane, protoze maji byt mimo policko. Tyhle je
// nahrazuji - stepUp/stepDown je metoda samotneho inputu, takze se drzi
// jeho min, max i step a nic se nepocita rucne.
//
// stepUp() ale zmenu neohlasi zadnou udalosti, proto se "input" posila
// rucne - jinak by o zmene nevedel nikdo, kdo na policko posloucha.
document.addEventListener("click", (event) => {
    const arrow = event.target.closest?.(".stepArrow")

    if (!arrow) {
        return
    }

    const field = document.getElementById(arrow.dataset.input)

    if (!field) {
        console.warn(`[FE] Step arrow points at "${arrow.dataset.input}", which is not on the page.`)
        return
    }

    if (arrow.dataset.step === "up") {
        field.stepUp()
    } else {
        field.stepDown()
    }

    field.dispatchEvent(new Event("input", { bubbles: true }))
})

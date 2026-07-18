#include <Arduino.h>
#include <Wire.h>
#include <array>
#include <cctype>

#include "cmath"
#include "vector"


#define EMERGENCY_PIN 2
#define LEAD_T8 2
#define JUMPER 2
#define PULLEY_TEETH 16
#define MAX_X 75
#define MAX_Y 95
#define MAX_Z 25
#define MAX_SPEED 160
#define SPINDL_PIN 11
#define MINIMAL_DISTANCE_STEP 25


struct Position {
    float x, y;
};

//cmd 1 = jednoduchy move, cmd 0 = ping a otestovani, cmd 2 = nastaveni rychlosti spindl, cmd 3 = homing, cmd 4 = homing na MAX vseho, cmd 5 zvednout pak jet, cmd 6 move Z
struct basicCMD {
    uint8_t command;
    Position position;
    float z, speed;

    basicCMD(uint8_t cmd = 0, Position position = {-1, -1}, float z = -1, float speed = -1) {
        this->command = cmd;
        this->position = position;
        this->z = z;
        this->speed = speed;
    }
};


struct nanoReport {
    uint8_t status;
    uint8_t error;
    Position position;
    float z;
    float speed;
    float spindleSpeed;

    nanoReport(uint8_t status = 0, uint8_t error = 0, Position position = {0, 0}, float z = 0, float speed = 0, float spindleSpeed = 0) {
        this->status = status;
        this->error = error;
        this->position = position;
        this->z = z;
        this->speed = speed;
        this->spindleSpeed = spindleSpeed;

    }

    void prepareForRPI(char buffer[], size_t bufSize) {
        int offset = 0;
        buffer[0] = '$';
        offset += snprintf(buffer + offset, bufSize - offset, "%d;", status);
        offset += snprintf(buffer + offset, bufSize - offset, "%d;", error);
        offset += snprintf(buffer + offset, bufSize - offset, "%.4f;", position.x);
        offset += snprintf(buffer + offset, bufSize - offset, "%.4f;", position.y);
        offset += snprintf(buffer + offset, bufSize - offset, "%.4f;", z);
        offset += snprintf(buffer + offset, bufSize - offset, "%.4f;", speed);

        if (offset >= (int)bufSize) {
            offset = bufSize - 1;
            buffer[offset++] = '\n';
            buffer[offset] = '\0';
        }

    }
};


struct motorNema17 {
    uint8_t stepPin, dirPin, endStopFrontPin, endStopEndPin;
    volatile uint8_t* portStep, *portESF, *portESE;

    void moveAwayFromEndStop(bool direction) {
        if (direction) {
            digitalWrite(dirPin, HIGH);
        } else {
            digitalWrite(dirPin, LOW);
        }
        for (int i = 0; i < MINIMAL_DISTANCE_STEP; ++i) {
            *portStep |= stepPin;
            delayMicroseconds(2);
            *portStep &= ~stepPin;
        }
    }
};


//function created by Claude, I was to lazy to think
void presetOCR1A(long &wantedFreq, uint8_t &presetTCCR1B) {
    // prescalery Timeru1, od nejmenšího (nejmenší = nejjemnější rozlišení)
    static const struct { uint16_t prescaler; uint8_t csBits; } opts[] = {
        {1,    (1 << CS10)},
        {8,    (1 << CS11)},
        {64,   (1 << CS11) | (1 << CS10)},
        {256,  (1 << CS12)},
        {1024, (1 << CS12) | (1 << CS10)},
    };

    if (wantedFreq < 1) wantedFreq = 1;

    for (uint8_t i = 0; i < 5; i++) {
        long base  = (long)(F_CPU / opts[i].prescaler);
        long ticks = (base + wantedFreq / 2) / wantedFreq;   // zaokrouhli na nejbližší
        if (ticks < 1) ticks = 1;
        long ocr = ticks - 1;

        if (ocr <= 65535) {                                  // vejde se do 16 bitů?
            OCR1A = (uint16_t)ocr;
            presetTCCR1B = (1 << WGM12) | opts[i].csBits;     // CTC + zvolený prescaler
            wantedFreq = base / ticks;   // ZAPÍŠEME ZPĚT skutečně dosaženou frekvenci
            return;
        }
    }

    // frekvence nižší, než zvládne i /1024 → nejpomalejší možné nastavení
    OCR1A = 65535;
    presetTCCR1B = (1 << WGM12) | (1 << CS12) | (1 << CS10);
    wantedFreq = (long)(F_CPU / 1024) / 65536L;
}


struct calibration {
    float stepTime;
    float stepLenghtGT2, stepLenghtT8; // pocet kroku na 1 mm!!!!
    uint8_t leadT8;
    int curStepX, curStepY, curStepZ;
    int maxStepX, maxStepY, maxStepZ;
    motorNema17 motorX, motorY, motorZ;
    uint8_t enablePin;
    uint32_t counterX, counterY, counterZ;
    uint32_t countingX, countingY, countingZ;
    uint16_t maxSpeedX, maxSpeedY, maxSpeedZ; // in mm/s
    uint8_t maxX, maxZ, maxY;
    uint8_t pulleyNumTeeth; // how many teeth does the pulley have
    uint8_t jumperDown;
    uint8_t presetTCCR1B;
    uint8_t clockX, clockY, clockZ;
    long masterFreq;
    int finishedJob = 0;
    uint8_t currentError = 0;
    
    calibration(uint16_t maxSpeedX = MAX_SPEED, uint16_t maxSpeedY = MAX_SPEED, uint16_t maxSpeedZ = MAX_SPEED,
                uint8_t pulleyNumTeeth = PULLEY_TEETH, uint8_t jumperDown = JUMPER, uint8_t leadT8 = LEAD_T8, uint8_t maxX = MAX_X, uint8_t maxY = MAX_Y, uint8_t maxZ = MAX_Z) {
        this->maxSpeedX = maxSpeedX;
        this->maxSpeedY = maxSpeedY;
        this->maxSpeedZ = maxSpeedZ;
        this->pulleyNumTeeth = pulleyNumTeeth;
        this->jumperDown = jumperDown; // as in microsteps as 1/8 of a step
        this->leadT8 = leadT8; // for me
        this->maxX = maxX; // in mm, maximal physical limit in the lenght of the axis, of this contruction
        this->maxY = maxY;
        this->maxZ = maxZ;

        this->stepTime = 2; // in microsekunds

        // 001 = 2/200 (200 steps (nema17) and 2mm (GT2))
        this->stepLenghtGT2 = ((float)this->jumperDown * 200.0f) / ((float)this->pulleyNumTeeth * 2.0f);
        this->stepLenghtT8 = ((float)this->jumperDown * 200.0f) / ((float)this->leadT8);
    
        this->curStepX = 0;
        this->curStepY = 0;
        this->curStepZ = 0;

        //using GT2 = 2 mm and a classic nema 17 = 200 steps per rotation
        //master clock is 10 times bigger to allow for decimal clocking with bigger accuracy
        long wantedMaxFreq = 10UL * ((float)(std::max(std::max(this->maxSpeedX, this->maxSpeedY), this->maxSpeedZ)) / (float)(2 * this->pulleyNumTeeth)) * (this->jumperDown * 200);
        presetOCR1A(wantedMaxFreq, presetTCCR1B);
        this->masterFreq = wantedMaxFreq;
        this->maxStepX = std::floor(this->stepLenghtGT2 * this->maxX);
        this->maxStepY = std::floor(this->stepLenghtGT2 * this->maxY);
        this->maxStepZ = std::floor(this->stepLenghtT8 * this->maxZ);
    }

    void setupFreqX(uint16_t freq) {
        countingX = 0;
        counterX = (masterFreq / freq) - 1;
        clockX = 1;
    }

    void setupFreqY(uint16_t freq) {
        countingY = 0;
        counterY = (masterFreq / freq) - 1;
        clockY = 1;
    }

    void setupFreqZ(uint16_t freq) {
        countingZ = 0;
        counterZ = (masterFreq / freq) - 1;
        clockZ = 1;
    }

    void endFreqX() {
        countingX = 0;
        counterX = 0;
        clockX = 0;
    }

    void endFreqY() {
        countingY = 0;
        counterY = 0;
        clockY = 0;
    }

    void endFreqZ() {
        countingZ = 0;
        counterZ = 0;
        clockZ = 0;
    }

    //function created by Claude, I was to lazy to think
    void setupPins(uint8_t enablePinArg,
                    uint8_t stepXpin, uint8_t dirXpin, uint8_t esXFrontPin, uint8_t esXEndPin,
                    uint8_t stepYpin, uint8_t dirYpin, uint8_t esYFrontPin, uint8_t esYEndPin,
                    uint8_t stepZpin, uint8_t dirZpin, uint8_t esZFrontPin, uint8_t esZEndPin) {

        enablePin = enablePinArg;
        pinMode(enablePin, OUTPUT);

        motorX.dirPin = dirXpin;  pinMode(dirXpin, OUTPUT);
        motorY.dirPin = dirYpin;  pinMode(dirYpin, OUTPUT);
        motorZ.dirPin = dirZpin;  pinMode(dirZpin, OUTPUT);

        pinMode(stepXpin, OUTPUT);
        motorX.portStep = portOutputRegister(digitalPinToPort(stepXpin));
        motorX.stepPin = digitalPinToBitMask(stepXpin);

        pinMode(stepYpin, OUTPUT);
        motorY.portStep = portOutputRegister(digitalPinToPort(stepYpin));
        motorY.stepPin = digitalPinToBitMask(stepYpin);

        pinMode(stepZpin, OUTPUT);
        motorZ.portStep = portOutputRegister(digitalPinToPort(stepZpin));
        motorZ.stepPin = digitalPinToBitMask(stepZpin);

        pinMode(esXFrontPin, INPUT_PULLUP);
        motorX.portESF = portInputRegister(digitalPinToPort(esXFrontPin));
        motorX.endStopFrontPin = digitalPinToBitMask(esXFrontPin);

        pinMode(esXEndPin, INPUT_PULLUP);
        motorX.portESE = portInputRegister(digitalPinToPort(esXEndPin));
        motorX.endStopEndPin = digitalPinToBitMask(esXEndPin);

        pinMode(esYFrontPin, INPUT_PULLUP);
        motorY.portESF = portInputRegister(digitalPinToPort(esYFrontPin));
        motorY.endStopFrontPin = digitalPinToBitMask(esYFrontPin);

        pinMode(esYEndPin, INPUT_PULLUP);
        motorY.portESE = portInputRegister(digitalPinToPort(esYEndPin));
        motorY.endStopEndPin = digitalPinToBitMask(esYEndPin);

        pinMode(esZFrontPin, INPUT_PULLUP);
        motorZ.portESF = portInputRegister(digitalPinToPort(esZFrontPin));
        motorZ.endStopFrontPin = digitalPinToBitMask(esZFrontPin);

        pinMode(esZEndPin, INPUT_PULLUP);
        motorZ.portESE = portInputRegister(digitalPinToPort(esZEndPin));
        motorZ.endStopEndPin = digitalPinToBitMask(esZEndPin);
}
};


struct toolheadInfo {
    Position position;
    float z, speed, spindleSpeed;
};



toolheadInfo basicToolHead() {
    toolheadInfo toolHead;
    toolHead.position.x = 0;
    toolHead.position.y = 0;
    toolHead.z = 0;
    toolHead.speed = 1;

    return toolHead;
}

calibration myCalib = calibration();
//change value
bool spindlON = true;
uint8_t spindlPin = SPINDL_PIN;


static void timer1Start() {
    noInterrupts();
    TCCR1A = 0;
    TCCR1B = 0;
    TCNT1 = 0;
    TCCR1B = myCalib.presetTCCR1B;
    TIMSK1 |= (1 << OCIE1A);

    interrupts();
}


static void timer1Stop() {
    TIMSK1 &= ~(1 << OCIE1A);
    TCCR1B = 0;
}


void interuptX() {
    if (!(*myCalib.motorX.portESF & myCalib.motorX.endStopFrontPin) || !(*myCalib.motorX.portESE & myCalib.motorX.endStopEndPin) || myCalib.curStepX >= myCalib.maxStepX) {
        myCalib.endFreqX();
        myCalib.finishedJob += 1;
        if (!(*myCalib.motorX.portESF & myCalib.motorX.endStopFrontPin)) {
            myCalib.motorX.moveAwayFromEndStop(true);
            myCalib.finishedJob = 22;
        }
        if (!(*myCalib.motorX.portESE & myCalib.motorX.endStopEndPin)) {
            myCalib.motorX.moveAwayFromEndStop(false);
            myCalib.finishedJob = 22;
        }
        return;
    }

    else {
        *myCalib.motorX.portStep |= (myCalib.motorX.stepPin);
        delayMicroseconds(myCalib.stepTime);
        *myCalib.motorX.portStep &= ~(myCalib.motorX.stepPin);
        return;
    }
}


void interuptY() {
    if (!(*myCalib.motorY.portESF & myCalib.motorY.endStopFrontPin) || !(*myCalib.motorY.portESE & myCalib.motorY.endStopEndPin) || myCalib.curStepY >= myCalib.maxStepY) {
        myCalib.endFreqY();
        myCalib.finishedJob += 1;
        if (!(*myCalib.motorY.portESF & myCalib.motorY.endStopFrontPin)) {
            myCalib.motorY.moveAwayFromEndStop(true);
            myCalib.finishedJob = 22;
        }
        if (!(*myCalib.motorY.portESE & myCalib.motorY.endStopEndPin)) {
            myCalib.motorY.moveAwayFromEndStop(false);
            myCalib.finishedJob = 22;
        }
        return;
    }

    else {
        *myCalib.motorY.portStep |= (myCalib.motorY.stepPin);
        delayMicroseconds(myCalib.stepTime);
        *myCalib.motorY.portStep &= ~(myCalib.motorY.stepPin);
        return;
    }
}


void interuptZ() {
    if (!(*myCalib.motorZ.portESF & myCalib.motorZ.endStopFrontPin) || !(*myCalib.motorZ.portESE & myCalib.motorZ.endStopEndPin) || myCalib.curStepZ >= myCalib.maxStepZ) {
        myCalib.endFreqZ();
        myCalib.finishedJob = 2;
        if (!(*myCalib.motorZ.portESF & myCalib.motorZ.endStopFrontPin)) {
            myCalib.motorZ.moveAwayFromEndStop(true);
            myCalib.finishedJob = 22;
        }
        if (!(*myCalib.motorZ.portESE & myCalib.motorZ.endStopEndPin)) {
            myCalib.motorZ.moveAwayFromEndStop(false);
            myCalib.finishedJob = 22;
        }
        return;
    }

    else {
        *myCalib.motorZ.portStep |= (1 << myCalib.motorZ.stepPin);
        delayMicroseconds(myCalib.stepTime);
        *myCalib.motorZ.portStep &= ~(1 << myCalib.motorZ.stepPin);
        return;
    }
}


//a single turning off function
void emergencyButtonInterupt() {
    digitalWrite(myCalib.enablePin, HIGH);
    analogWrite(spindlPin, 0);
    spindlON = false;
    myCalib.endFreqX();
    myCalib.endFreqY();
    myCalib.endFreqZ();
    timer1Stop();
    myCalib.currentError = 10;
}


ISR(TIMER1_COMPA_vect) {
    if (myCalib.clockX == 1) {
        myCalib.countingX += 1;
        if (myCalib.counterX <= myCalib.countingX) {
            myCalib.countingX = 0;
            interuptX();
        }
    }

    if (myCalib.clockY == 1) {
        myCalib.countingY += 1;
        if (myCalib.counterY <= myCalib.countingY) {
            myCalib.countingY = 0;
            interuptY();
        }
    }

    if (myCalib.clockZ == 1) {
        myCalib.countingZ += 1;
        if (myCalib.counterZ <= myCalib.countingZ) {
            myCalib.countingZ = 0;
            interuptZ();
        }
    }
}


float loadNum(char *buffer, size_t size, int &currentChar) {
    float oneNumber = 0;
    float floatinDecimal = 0;
    bool negativity = false;
    bool fullNum = false;
    char curChar = ' ';

    while (currentChar < size) {
        curChar = buffer[currentChar];
        if (std::isdigit(curChar)) {
            break;
        }

        if (curChar == '-') {
            negativity = true;
        }

        currentChar += 1;
    }

    while (currentChar < size) {
        curChar = buffer[currentChar];
        if (!(std::isdigit(curChar)) && !(curChar == '.')) {
            break;
        }

        if (curChar == '.' && !fullNum) {
            fullNum = true;
            currentChar += 1;
            continue;
        }

        if (fullNum) {
            floatinDecimal += 1;
        }

        oneNumber *= 10;
        oneNumber += int(curChar - '0');
        currentChar += 1;

        if (currentChar >= size) {
            break;
        }
    }

    oneNumber /= std::pow(10, floatinDecimal);
    if (negativity) {
        oneNumber *= -1;
    }

    return oneNumber;
}


struct cnc {
    toolheadInfo myToolHead;
    std::array<uint8_t, 7> motorPins; // enable, X step, X dir, Y .... Z ...
    float conversionConst;
    std::array<uint8_t, 6> endStop;
    char cmdBuf[64] = {};
    nanoReport report;
    basicCMD cmd;
    bool homed;

    cnc(std::array<uint8_t, 7> motorPins, std::array<uint8_t, 6> endStop, uint16_t maxSpindlSpeed = 20000) {
        this->motorPins = motorPins;
        this->endStop = endStop;
        this->conversionConst = 255.0f / (float)maxSpindlSpeed;
        myToolHead = basicToolHead();
    }

    void initialate() {
        Serial.begin(9600);
        timer1Start();
        myCalib.setupPins(motorPins[0],motorPins[1],motorPins[2],endStop[0],endStop[1],
            motorPins[3],motorPins[4],endStop[2],endStop[3],motorPins[5],motorPins[6],endStop[4],endStop[5]);
        digitalWrite(myCalib.enablePin, LOW);
        myCalib.finishedJob = 0;
        attachInterrupt(digitalPinToInterrupt(EMERGENCY_PIN), emergencyButtonInterupt, RISING);
    }


    void operateCMD5(basicCMD &cmd) {
        controlSpindl(0);
        moveZ(cmd.z);
        move2D(cmd.position);
    }

    void home(bool dir) {
        controlSpindl(0);
        myCalib.maxStepZ = 1;
        myCalib.maxStepY = 1;
        myCalib.maxStepX = 1;
        if (dir) {
            digitalWrite(myCalib.motorX.dirPin, HIGH);
            digitalWrite(myCalib.motorY.dirPin, HIGH);
            digitalWrite(myCalib.motorZ.dirPin, HIGH);
        }

        else {
            digitalWrite(myCalib.motorX.dirPin, LOW);
            digitalWrite(myCalib.motorY.dirPin, LOW);
            digitalWrite(myCalib.motorZ.dirPin, LOW);
        }

        myCalib.setupFreqZ(myCalib.maxSpeedZ);
        while (myCalib.finishedJob < 2) {
            //waiting for interupts to
        }

        myCalib.setupFreqY(myCalib.maxSpeedY);
        while (myCalib.finishedJob < 1) {
            //waiting for interupts to
        }

        myCalib.setupFreqX(myCalib.maxSpeedX);
        while (myCalib.finishedJob < 1) {
            //waiting for interupts to
        }


        if (dir) {
            myToolHead.position.x = myCalib.maxX;
            myToolHead.position.y = myCalib.maxY;
            myToolHead.z = myCalib.maxZ;
        }

        else {
            myToolHead.position.x = 0;
            myToolHead.position.y = 0;
            myToolHead.z = 0;
        }
        homed = true;
    }

    void clampLocation(Position &location) {
        if (location.x > myCalib.maxX) {
            location.x = myCalib.maxX;
            myCalib.currentError = 6;
        }

        if (location.y > myCalib.maxY) {
            location.y = myCalib.maxY;
            myCalib.currentError = 6;
        }

        if (location.x < 0) {
            location.x = 0;
            myCalib.currentError = 6;
        }

        if (location.y < 0) {
            location.y = 0;
            myCalib.currentError = 6;
        }
    }

    void clampZ(float &z) {
        if (z > myCalib.maxZ) {
            z = myCalib.maxZ;
            myCalib.currentError = 6;
        }

        if (z < 0) {
            z = 0;
            myCalib.currentError = 6;
        }
    }

    void operateInstr() {
        myCalib.currentError = 0;
        basicCMD cmd = loadCMD();

        if (!(cmd.speed == -1)) {
            myToolHead.speed = cmd.speed;
        }

        if (cmd.command == 1) {
            move2D(cmd.position);
        }

        else if (cmd.command == 0) {
            myCalib.currentError = 4;
        }

        else if (cmd.command == 5) {
            operateCMD5(cmd);
        }

        else if (cmd.command == 3) {
            home(false);
        }

        else if (cmd.command == 4) {
            home(true);
        }

        else if (cmd.command == 25) {
            myCalib.currentError = 3;
        }

        else {
            myCalib.currentError = 4;
        }

        report = nanoReport(0, myCalib.currentError, {myToolHead.position.x, myToolHead.position.y,}, myToolHead.z, myToolHead.speed, myToolHead.spindleSpeed);
        sendNanoReport();
    }

    basicCMD loadCMD() {
        basicCMD returningCMD = basicCMD();
        size_t len;
        cmdBuf[64] = {};
        if (Serial.find('$')) {
            len = Serial.readBytesUntil('\n', cmdBuf, 64);
            cmdBuf[len] = '\0';
            int curChar = 0;
            returningCMD.command = loadNum(cmdBuf, len, curChar);
            if (cmdBuf[curChar] == ';') {
                curChar += 1;
            }

            else {
                return basicCMD(25);
            }

            returningCMD.position.x = loadNum(cmdBuf, len, curChar);

            if (cmdBuf[curChar] == ';') {
                curChar += 1;
            }

            else {
                return basicCMD(25);
            }

            returningCMD.position.y = loadNum(cmdBuf, len, curChar);

            if (cmdBuf[curChar] == ';') {
                curChar += 1;
            }

            else {
                return basicCMD(25);
            }
            returningCMD.z = loadNum(cmdBuf, len, curChar);

            if (cmdBuf[curChar] == ';') {
                curChar += 1;
            }

            else {
                return basicCMD(25);
            }

            returningCMD.speed = loadNum(cmdBuf, len, curChar);
        }
        return returningCMD;
    }

    void sendNanoReport() {
        cmdBuf[64] = {};
        report.prepareForRPI(cmdBuf, 64);
        Serial.write(cmdBuf, 64);
    }

    void moveZ(float z) {
        if (z == -1) {
            z = myToolHead.z;
        }
        clampZ(z);

        if (z >= myToolHead.z) {
            digitalWrite(motorPins[7], HIGH);
        }

        else {
            digitalWrite(motorPins[7], LOW);
        }
        float lenghtZ = z - myToolHead.z;
        myCalib.maxStepZ = abs(myCalib.stepLenghtT8 * lenghtZ);
        int freqZ = int(myCalib.stepLenghtT8 / myToolHead.speed);

        if (lenghtZ != 0) {
            myCalib.setupFreqZ(freqZ);
        }

        while (myCalib.finishedJob < 2) {
            //waiting for interupts to
        }

        if (myCalib.finishedJob == 22) {
            homed = false;
            myCalib.currentError = 7;
        }

        myToolHead.z = z;
    }

    void move2D(Position location) {
        if (location.x == -1) {
            location.x = myToolHead.position.x;
        }

        if (location.y == -1) {
            location.y = myToolHead.position.y;
        }

        clampLocation(location);

        if (location.x >= myToolHead.position.x) {
            digitalWrite(myCalib.motorX.dirPin, HIGH);
        }

        else {
            digitalWrite(myCalib.motorX.dirPin, LOW);
        }

        if (location.y >= myToolHead.position.y) {
            digitalWrite(myCalib.motorY.dirPin, HIGH);
        }

        else {
            digitalWrite(myCalib.motorY.dirPin, LOW);
        }
        float lenghtX = location.x - myToolHead.position.x;
        float lenghtY = location.y - myToolHead.position.y;
        float lenght = sqrt(pow((lenghtX), 2) + pow((lenghtY), 2));
        float totalTime = lenght / myToolHead.speed;
        myCalib.maxStepX = abs(myCalib.stepLenghtGT2 * lenghtX);
        myCalib.maxStepY = abs(myCalib.stepLenghtGT2 * lenghtY);
        int freqX = int(myCalib.maxStepX / totalTime); // matematicky prepis tohodle:  1 / (totalTime / totalStepsX)
        int freqY = int(myCalib.maxStepY / totalTime);

        if (lenghtX != 0) {
            myCalib.setupFreqX(freqX);
        }
        if (lenghtY != 0) {
            myCalib.setupFreqX(freqY);
        }

        while (myCalib.finishedJob < 2) {
            //waiting for interupts to
        }

        if (myCalib.finishedJob == 22) {
            homed = false;
            myCalib.currentError = 7;
        }

        myToolHead.position = location;
    }

    void controlSpindl(uint8_t speed) {
        if (spindlON) {
            speed = (uint8_t)((float)speed * conversionConst);
            if (speed <= 0) {
                digitalWrite(spindlPin, LOW);
            }
            if (speed >= 255) {
                digitalWrite(spindlPin, HIGH);
            }
            analogWrite(spindlPin, speed);
        }
    }
};


cnc myCNC = cnc({1,2,3,4,5,6}, {1,2,3,4,5,6});

void setup() {
    myCNC.initialate();
}

void loop() {
    myCNC.operateInstr();
}
